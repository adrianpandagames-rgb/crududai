// Runs the Maigret OSINT tool for one username and turns its JSON reports into account rows.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAIGRET_MODES = {
  rapida: { label: 'Rápida (100 sitios)', args: ['--top-sites', '100'], timeoutMs: 10 * 60 * 1000 },
  normal: { label: 'Normal (500 sitios)', args: ['--top-sites', '500'], timeoutMs: 20 * 60 * 1000 },
  completa: { label: 'Completa (todos los sitios)', args: ['--all-sites'], timeoutMs: 60 * 60 * 1000 },
};

const LOG_TAIL_LENGTH = 4000;
const MAX_FIELD_LENGTH = 500;

export const normalizeUsername = (value) => String(value ?? '').trim().replace(/^@/, '');

// A leading dash would be read as a Maigret option, so names must start with a letter, digit or underscore.
export const isValidUsername = (value) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(value);

export function buildMaigretArgs({ username, mode, recursive, outputDir }) {
  return [
    username,
    ...MAIGRET_MODES[mode].args,
    '--timeout', '20',
    '--retries', '1',
    '--no-progressbar',
    '--no-color',
    '--json', 'simple',
    '--html',
    '--folderoutput', outputDir,
    ...(recursive ? [] : ['--no-recursion']),
  ];
}

const isWebUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

// Each report maps a site name to its check; only "Claimed" checks are accounts that exist.
export function parseMaigretReports(reports) {
  const accounts = [];
  reports.forEach(({ username, data }, order) => {
    for (const [siteKey, entry] of Object.entries(data ?? {})) {
      const status = entry?.status;
      if (status?.status !== 'Claimed') continue;
      const url = [status.url, entry.url_user].find(isWebUrl) ?? null;
      const fields = Object.entries(status.ids ?? {})
        .filter(([key, value]) => !key.startsWith('_') && value !== null && value !== '')
        .map(([key, value]) => ({
          key,
          value: String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, MAX_FIELD_LENGTH),
          isLink: isWebUrl(value),
        }));
      accounts.push({
        username: String(entry.username ?? status.username ?? username),
        site: String(status.site_name ?? siteKey),
        url,
        tags: [...new Set([...(status.tags ?? []), ...(entry.site?.tags ?? [])])].map(String),
        similar: entry.is_similar === true,
        fields,
        order,
        rank: Number.isFinite(entry.rank) ? entry.rank : Number.MAX_SAFE_INTEGER,
      });
    }
  });
  return accounts
    .sort((a, b) => a.order - b.order || a.rank - b.rank || a.site.localeCompare(b.site))
    .map(({ order, rank, ...account }) => account);
}

const appendTail = (tail, chunk) => (tail + chunk).slice(-LOG_TAIL_LENGTH);

export async function runMaigret({ username, mode, recursive, signal, bin = process.env.MAIGRET_BIN || 'maigret' }) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'maigret-'));
  try {
    let log = '';
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(bin, buildMaigretArgs({ username, mode, recursive, outputDir }), {
        cwd: outputDir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });
      const stop = () => child.kill('SIGKILL');
      const timer = setTimeout(stop, MAIGRET_MODES[mode].timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk) => { log = appendTail(log, chunk.toString('utf8')); });
      child.stderr.on('data', (chunk) => { log = appendTail(log, chunk.toString('utf8')); });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT'
          ? new Error('Maigret no está instalado en el servidor.')
          : error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve(code);
      });
    });
    if (signal?.aborted) throw new Error('La búsqueda fue cancelada.');

    const files = await readdir(outputDir);
    const reports = [];
    for (const file of files) {
      const match = /^report_(.+)_simple\.json$/.exec(file);
      if (!match) continue;
      reports.push({ username: match[1], data: JSON.parse(await readFile(path.join(outputDir, file), 'utf8')) });
    }
    // The searched name goes first; names found along the way follow.
    reports.sort((a, b) => Number(b.username === username) - Number(a.username === username));
    if (reports.length === 0) {
      throw new Error(exitCode === null
        ? 'La búsqueda superó el tiempo máximo y fue detenida.'
        : `Maigret no generó resultados. ${log.trim().split('\n').slice(-3).join(' ')}`.slice(0, 500));
    }
    const htmlFile = files.find((file) => file === `report_${username}_plain.html`)
      ?? files.find((file) => /^report_.+_plain\.html$/.test(file));
    return {
      accounts: parseMaigretReports(reports),
      usernames: reports.map((report) => report.username),
      reportHtml: htmlFile ? await readFile(path.join(outputDir, htmlFile), 'utf8') : null,
      truncated: exitCode === null,
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
