// Runs the OSINT tools that complement Maigret: Sherlock (second opinion on usernames),
// Holehe (sites where an e-mail is registered) and Ignorant (sites where a phone is registered).
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCsv } from './rutaService.js';

const LOG_TAIL_LENGTH = 4000;
const appendTail = (tail, chunk) => (tail + chunk).slice(-LOG_TAIL_LENGTH);
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

// E-mails and phones go to the tools as command-line arguments, so they must never start with a dash.
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
export const isValidEmail = (value) => value.length <= 254
  && /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(value);

export const normalizeCountryCode = (value) => String(value ?? '').replace(/\D/g, '');
export const normalizePhone = (value) => String(value ?? '').replace(/\D/g, '');
export const isValidCountryCode = (value) => /^[1-9]\d{0,2}$/.test(value);
export const isValidPhone = (value) => /^\d{6,14}$/.test(value);

// "juan.perez+trabajo@gmail.com" → "juan.perez": the alias people often reuse as a username.
export function emailAlias(email) {
  const local = String(email).split('@')[0].split('+')[0];
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(local) ? local : null;
}

// Spawns a tool in a fresh temporary folder and returns its exit code, output tail and the files it wrote.
export async function runTool(bin, args, { timeoutMs, signal, missingMessage }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'osint-'));
  try {
    let log = '';
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: dir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1' },
        windowsHide: true,
      });
      const stop = () => child.kill('SIGKILL');
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk) => { log = appendTail(log, chunk.toString('utf8')); });
      child.stderr.on('data', (chunk) => { log = appendTail(log, chunk.toString('utf8')); });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? new Error(missingMessage) : error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve(code);
      });
    });
    if (signal?.aborted) throw new Error('La búsqueda fue cancelada.');
    const files = {};
    for (const file of await readdir(dir)) files[file] = await readFile(path.join(dir, file), 'utf8');
    return { exitCode, log: stripAnsi(log), files };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const csvRecords = (text) => {
  const rows = parseCsv(String(text ?? '').replace(/^﻿/, ''), ',');
  const [header = [], ...data] = rows;
  return data.filter((row) => row.some((cell) => String(cell).trim()))
    .map((row) => Object.fromEntries(header.map((key, index) => [String(key).trim(), row[index] ?? ''])));
};
const isWebUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const lastLines = (log) => log.trim().split('\n').slice(-3).join(' ').slice(0, 300);

// ---- Sherlock ------------------------------------------------------------------------------

export const SHERLOCK_TIMEOUT_MS = 8 * 60 * 1000;

export const buildSherlockArgs = (username) => [username, '--csv', '--print-found', '--no-color', '--timeout', '20'];

// Sherlock writes "<username>.csv" with only the sites where the account exists ("Claimed").
export function parseSherlockCsv(text) {
  return csvRecords(text)
    .filter((record) => String(record.exists).trim().toLowerCase() === 'claimed')
    .map((record) => ({
      site: String(record.name || '').trim(),
      url: isWebUrl(record.url_user) ? record.url_user.trim() : null,
    }))
    .filter((account) => account.site);
}

export async function runSherlock({ username, signal, bin = process.env.SHERLOCK_BIN || 'sherlock' }) {
  const { exitCode, log, files } = await runTool(bin, buildSherlockArgs(username), {
    timeoutMs: SHERLOCK_TIMEOUT_MS, signal, missingMessage: 'Sherlock no está instalado en el servidor.',
  });
  const csv = files[`${username}.csv`] ?? Object.entries(files).find(([name]) => name.endsWith('.csv'))?.[1];
  if (csv === undefined) {
    throw new Error(exitCode === null ? 'Sherlock superó el tiempo máximo.' : `Sherlock no generó resultados. ${lastLines(log)}`);
  }
  return parseSherlockCsv(csv);
}

// Site names differ in detail between the tools ("GitHubGist [GitHub]" vs "GitHubGist"), and so do URLs.
const siteKey = (site) => String(site ?? '').replace(/\[.*?\]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const urlKey = (url) => (url ? String(url).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#]+$/, '') : null);

// Accounts found by both tools are "confirmed"; the rest are kept as "possible" with the tool that found them.
export function mergeSherlockAccounts(maigretAccounts, sherlockAccounts, username) {
  const sherlockSites = new Map(sherlockAccounts.map((account) => [siteKey(account.site), account]));
  const sherlockUrls = new Map(sherlockAccounts.filter((account) => account.url).map((account) => [urlKey(account.url), account]));
  const matched = new Set();
  const accounts = maigretAccounts.map((account) => {
    if (account.username !== username) return { ...account, sources: ['maigret'] };
    const match = sherlockSites.get(siteKey(account.site)) ?? (account.url ? sherlockUrls.get(urlKey(account.url)) : undefined);
    if (match) matched.add(match);
    return { ...account, sources: match ? ['maigret', 'sherlock'] : ['maigret'] };
  });
  const onlySherlock = sherlockAccounts.filter((account) => !matched.has(account))
    .map(({ site, url }) => ({ username, site, url, tags: [], similar: false, fields: [], sources: ['sherlock'] }));
  // Confirmed accounts first within the searched name; aliases keep Maigret's order after them.
  const main = [...accounts.filter((account) => account.username === username), ...onlySherlock]
    .sort((a, b) => b.sources.length - a.sources.length);
  return [...main, ...accounts.filter((account) => account.username !== username)];
}

// ---- Holehe ----------------------------------------------------------------------------------

export const HOLEHE_TIMEOUT_MS = 6 * 60 * 1000;

// --no-password-recovery skips the modules that could e-mail the owner a "reset your password" notice.
export const buildHoleheArgs = (email) => [email, '--only-used', '--no-color', '--no-clear', '--no-password-recovery', '--csv', '--timeout', '20'];

const flag = (value) => String(value).trim().toLowerCase() === 'true';
const cleanValue = (value) => {
  const text = String(value ?? '').trim();
  return text && text.toLowerCase() !== 'none' ? text : '';
};

// Holehe's CSV lists every site checked; keep the registered ones and those it could not verify.
export function parseHoleheCsv(text) {
  const records = csvRecords(text);
  const accounts = records.filter((record) => flag(record.exists)).map((record) => {
    const domain = cleanValue(record.domain);
    const fields = [
      ['Correo de recuperación', cleanValue(record.emailrecovery)],
      ['Teléfono asociado', cleanValue(record.phoneNumber)],
      ['Otros datos', cleanValue(record.others)],
    ].filter(([, value]) => value).map(([key, value]) => ({ key, value: value.slice(0, 500), isLink: false }));
    return { site: domain || cleanValue(record.name), url: domain ? `https://${domain}` : null, tags: [], similar: false, fields, sources: ['holehe'] };
  });
  const unverified = records.filter((record) => !flag(record.exists) && (flag(record.rateLimit) || flag(record.error)))
    .map((record) => cleanValue(record.domain) || cleanValue(record.name)).filter(Boolean);
  return { accounts, unverified };
}

export async function runHolehe({ email, signal, bin = process.env.HOLEHE_BIN || 'holehe' }) {
  const { exitCode, log, files } = await runTool(bin, buildHoleheArgs(email), {
    timeoutMs: HOLEHE_TIMEOUT_MS, signal, missingMessage: 'Holehe no está instalado en el servidor.',
  });
  const csv = Object.entries(files).find(([name]) => /^holehe_.*\.csv$/.test(name))?.[1];
  if (csv === undefined) {
    throw new Error(exitCode === null ? 'Holehe superó el tiempo máximo.' : `Holehe no generó resultados. ${lastLines(log)}`);
  }
  return parseHoleheCsv(csv);
}

// ---- Ignorant --------------------------------------------------------------------------------

export const IGNORANT_TIMEOUT_MS = 3 * 60 * 1000;

export const buildIgnorantArgs = (countryCode, phone) => [countryCode, phone, '--no-color', '--no-clear', '--timeout', '20'];

// Ignorant only prints lines: "[+] site" registered, "[-] site" not registered, "[x] site" rate limited.
export function parseIgnorantOutput(log) {
  const accounts = [];
  const unverified = [];
  let checked = 0;
  for (const line of stripAnsi(log).split(/\r?\n/)) {
    const match = /^\s*\[([+x-])\]\s+([a-z0-9.-]+\.[a-z]{2,})\b/i.exec(line);
    if (!match) continue;
    checked++;
    const domain = match[2].toLowerCase();
    if (match[1] === '+') accounts.push({ site: domain, url: `https://${domain}`, tags: [], similar: false, fields: [], sources: ['ignorant'] });
    if (match[1] === 'x') unverified.push(domain);
  }
  return { accounts, unverified, checked };
}

export async function runIgnorant({ countryCode, phone, signal, bin = process.env.IGNORANT_BIN || 'ignorant' }) {
  const { exitCode, log } = await runTool(bin, buildIgnorantArgs(countryCode, phone), {
    timeoutMs: IGNORANT_TIMEOUT_MS, signal, missingMessage: 'Ignorant no está instalado en el servidor.',
  });
  const result = parseIgnorantOutput(log);
  if (result.checked === 0) {
    throw new Error(exitCode === null ? 'Ignorant superó el tiempo máximo.' : `Ignorant no generó resultados. ${lastLines(log)}`);
  }
  return result;
}
