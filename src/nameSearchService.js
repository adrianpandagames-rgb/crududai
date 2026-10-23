// Name search over official public lists (OFAC SDN, SAT 69-B) plus prepared web searches.
import { parseCsvRow } from './csvUtils.js';

export const LIST_SOURCES = {
  ofac: {
    label: 'OFAC (sancionados por el Tesoro de EE. UU.)',
    urls: {
      sdn: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
      alt: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV',
    },
  },
  sat69b: {
    label: 'SAT 69-B (operaciones simuladas)',
    urls: { list: 'http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv' },
  },
};

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'sa', 'cv', 'rl', 'sc', 'sapi']);
const MAX_RESULTS = 50;
const OFAC_EMPTY = '-0-';

export const normalizeName = (value) => String(value ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const tokensOf = (value) => normalizeName(value).split(' ').filter(Boolean);
const meaningfulTokens = (value) => {
  const tokens = tokensOf(value);
  const kept = tokens.filter((token) => !STOPWORDS.has(token));
  return kept.length > 0 ? kept : tokens;
};

const ofacValue = (value) => (value === undefined || value.trim() === OFAC_EMPTY ? '' : value.trim());

export function parseOfac(sdnText, altText) {
  const entries = [];
  const primary = new Map();
  for (const line of sdnText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, name, type, program, title, , , , , , , remarks] = parseCsvRow(line).map(ofacValue);
    const kind = type || 'entidad';
    // Vessels and aircraft are not people or companies that a name search should return.
    if (!id || !name || kind === 'vessel' || kind === 'aircraft') continue;
    const details = {
      tipo: kind === 'individual' ? 'Persona' : 'Entidad',
      programa: program,
      ...(title ? { cargo: title } : {}),
      notas: remarks.slice(0, 1500),
    };
    primary.set(id, { name, details });
    entries.push({ source: 'ofac', sourceId: id, name, details });
  }
  for (const line of altText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, , altType, altName] = parseCsvRow(line).map(ofacValue);
    const main = primary.get(id);
    if (!main || !altName) continue;
    entries.push({ source: 'ofac', sourceId: id, name: altName, details: { ...main.details, aliasDe: main.name, tipoAlias: altType } });
  }
  return entries;
}

export function parseSat69b(text) {
  const entries = [];
  let headerFound = false;
  for (const line of text.split(/\r?\n/)) {
    if (!headerFound) {
      headerFound = /^No,RFC,/i.test(line);
      continue;
    }
    if (!line.trim()) continue;
    const [, rfc, name, situation] = parseCsvRow(line);
    if (!rfc || !name) continue;
    entries.push({
      source: 'sat69b',
      sourceId: rfc.toUpperCase(),
      name,
      details: { tipo: rfc.length === 13 ? 'Persona física' : 'Persona moral', rfc: rfc.toUpperCase(), situacion: situation || '' },
    });
  }
  return entries;
}

// True when a and b differ by at most one inserted, removed or replaced character.
export function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Spanish spellings that sound alike share a key: Joaquín/Joakin, Gusmán/Guzmán, Baldez/Valdés, Yamas/Llamas.
export const phoneticKey = (token) => token
  .replace(/ch/g, 'x').replace(/qu/g, 'k').replace(/c([ei])/g, 's$1').replace(/c/g, 'k')
  .replace(/z/g, 's').replace(/v/g, 'b').replace(/ll/g, 'y').replace(/h/g, '')
  .replace(/(.)\1+/g, '$1');

export function buildNameIndex(entries) {
  const records = entries.map((entry, position) => ({ ...entry, position, tokens: new Set(meaningfulTokens(entry.name)) }));
  const byToken = new Map();
  for (const record of records) {
    for (const token of record.tokens) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(record);
    }
  }
  const vocabulary = [...byToken.keys()];
  return { records, byToken, vocabulary, phonetic: vocabulary.map(phoneticKey) };
}

const IDENTIFIER_PATTERN = /^[a-z]{3,4}\d{6}[a-z0-9]{3}([a-z0-9]{5})?$/i;
export const isIdentifierQuery = (query) => IDENTIFIER_PATTERN.test(String(query).replace(/[\s-]/g, ''));

// Every query word must appear in the listed name, in any order: exactly, or for words of four or more
// letters with one letter of difference in spelling or in sound; initials match words that start with them.
export function searchNameIndex(index, query) {
  const compact = String(query).replace(/[\s-]/g, '').toUpperCase();
  if (isIdentifierQuery(compact)) {
    const hits = index.records.filter((record) => record.sourceId.toUpperCase() === compact
      || JSON.stringify(record.details).toUpperCase().includes(compact));
    return collapse(hits.map((record) => ({ record, score: 1, exact: true })));
  }
  const queryTokens = meaningfulTokens(query);
  if (queryTokens.length < 2) return [];
  let candidates = null;
  for (const queryToken of queryTokens) {
    const queryKey = phoneticKey(queryToken);
    const similar = index.vocabulary.filter((token, position) => token === queryToken
      || (queryToken.length === 1 && token.startsWith(queryToken))
      || (queryToken.length >= 4 && (withinOneEdit(queryToken, token) || withinOneEdit(queryKey, index.phonetic[position]))));
    const records = new Set(similar.flatMap((token) => index.byToken.get(token)));
    candidates = candidates ? new Set([...candidates].filter((record) => records.has(record))) : records;
  }
  // Exact words rank first; listed names with many extra words rank lower.
  const scored = [...candidates].map((record) => {
    const exactWords = queryTokens.filter((queryToken) => record.tokens.has(queryToken)).length;
    const extraWords = Math.max(0, record.tokens.size - queryTokens.length);
    return { record, exact: exactWords === queryTokens.length, score: exactWords / queryTokens.length - extraWords * 0.05 };
  });
  return collapse(scored);
}

// Aliases share the listed person's id; keep the best-matching name for each person or company.
function collapse(hits) {
  const best = new Map();
  for (const hit of hits) {
    const key = `${hit.record.source}:${hit.record.sourceId}`;
    if (!best.has(key) || hit.score > best.get(key).score) best.set(key, hit);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name))
    .slice(0, MAX_RESULTS)
    .map(({ record, exact }) => ({ source: record.source, sourceId: record.sourceId, name: record.name, exact, details: record.details }));
}

const google = (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

export function preparedSearches(name, city = '') {
  const quoted = `"${name.trim()}"`;
  const withCity = city.trim() ? `${quoted} ${city.trim()}` : quoted;
  const encoded = encodeURIComponent(name.trim());
  return [
    { group: 'Buscadores', links: [
      { name: 'Google', href: google(withCity) },
      { name: 'Google Noticias', href: `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(withCity)}` },
      { name: 'Bing', href: `https://www.bing.com/search?q=${encodeURIComponent(withCity)}` },
    ] },
    { group: 'Redes sociales (Google)', links: [
      ['Facebook', 'facebook.com'], ['Instagram', 'instagram.com'], ['TikTok', 'tiktok.com'],
      ['X', 'x.com'], ['LinkedIn', 'linkedin.com'], ['YouTube', 'youtube.com'],
    ].map(([label, site]) => ({ name: label, href: google(`${withCity} site:${site}`) })) },
    { group: 'Búsqueda dentro de cada red', links: [
      { name: 'Facebook personas', href: `https://www.facebook.com/search/people/?q=${encoded}` },
      { name: 'LinkedIn personas', href: `https://www.linkedin.com/search/results/people/?keywords=${encoded}` },
      { name: 'TikTok cuentas', href: `https://www.tiktok.com/search/user?q=${encoded}` },
      { name: 'X cuentas', href: `https://x.com/search?q=${encodeURIComponent(quoted)}&f=user` },
    ] },
    { group: 'Registros oficiales (escribe el nombre en el sitio)', links: [
      { name: 'Interpol notificaciones rojas', href: 'https://www.interpol.int/How-we-work/Notices/Red-Notices/View-Red-Notices' },
      { name: 'Cédula profesional SEP', href: 'https://www.cedulaprofesional.sep.gob.mx/' },
    ] },
  ];
}

// Mexican names usually end with the paternal and maternal surnames.
export function usernameVariants(name) {
  const tokens = tokensOf(name).filter((token) => !STOPWORDS.has(token));
  if (tokens.length < 2) return [];
  const first = tokens[0];
  const paternal = tokens.length >= 3 ? tokens[tokens.length - 2] : tokens[1];
  const maternal = tokens.length >= 3 ? tokens[tokens.length - 1] : '';
  const variants = [
    `${first}${paternal}`,
    `${first}.${paternal}`,
    `${first}_${paternal}`,
    `${first[0]}${paternal}`,
    maternal ? `${first}${paternal}${maternal[0]}` : `${paternal}${first}`,
  ];
  return [...new Set(variants)].filter((variant) => variant.length <= 64);
}
