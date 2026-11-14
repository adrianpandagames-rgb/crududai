import { sanitizeAuditData } from './auditDetails.js';

const auxiliary = new Set(['page', 'pagina', 'pageSize', 'partial', 'message', 'toastMessage']);
const empty = (value) => value === '' || value === null || value === undefined;

// One line of text for a value: lists joined with commas, objects as "campo: valor".
const inline = (value) => {
  if (Array.isArray(value)) return value.map(inline).join(', ');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${inline(item)}`).join(', ');
  return String(value ?? '');
};

// "campo: valor" lines, nested objects indented under their name; no JSON.
export function plainLines(value, indent = '') {
  return Object.entries(value || {}).filter(([, item]) => !empty(item)).flatMap(([key, item]) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return [`${indent}${key}:`, ...plainLines(item, `${indent}  `)];
    if (Array.isArray(item) && item.some((element) => element && typeof element === 'object')) {
      return [`${indent}${key}:`, ...item.map((element) => `${indent}  - ${inline(element)}`)];
    }
    return [`${indent}${key}: ${inline(item)}`];
  });
}

const sizeText = (bytes) => {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
};

// What the "Ver" arrow opens: the request, the record, its changes and what was sent, in plain text.
function detailText(entry, details) {
  const { datos, parametros, archivos, metodo, origen, comando, ...otros } = details || {};
  const sections = [
    [`Método: ${metodo || entry.method || '—'}`, `Ruta: ${entry.request_path || '—'}`,
      ...(entry.registro ? [`Registro: ${entry.registro}`] : [])],
  ];
  const block = (title, lines) => { if (lines.length) sections.push([`${title}:`, ...lines.map((line) => `  ${line}`)]); };
  block('Cambios', entry.cambios ? String(entry.cambios).split('\n') : []);
  block('Datos enviados', plainLines(datos));
  block('Parámetros', plainLines(parametros));
  block('Archivos', (archivos || []).map((file) => `${file.nombre || 'archivo'} (${sizeText(file.bytes)}${file.tipo ? `, ${file.tipo}` : ''})`));
  block('Otros datos', plainLines({ ...(origen ? { origen } : {}), ...(comando ? { comando } : {}), ...otros }));
  return sections.map((lines) => lines.join('\n')).join('\n\n');
}

export function presentAuditEntry(entry) {
  let details = entry.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = null; }
  }
  details = sanitizeAuditData(details);
  const legacyQuery = Object.fromEntries(new URLSearchParams(String(entry.request_path || '').split('?').slice(1).join('?')));
  const parameters = sanitizeAuditData({ ...legacyQuery, ...details?.parametros, ...details?.datos });
  const searched = Object.entries(parameters).filter(([key, value]) =>
    !auxiliary.has(key) && value !== '[OCULTO]' && !empty(value));
  const timestamp = String(entry.createdAt || '');
  return {
    ...entry,
    details,
    registro: entry.registro || '',
    cambios: entry.cambios || '',
    detalle: detailText(entry, details),
    origin: details?.origen === 'Telegram' ? `Telegram · /${details.comando || ''}` : 'Página web',
    searched: searched.map(([key, value]) => `${key}: ${inline(value)}`).join(' · ')
      || (entry.operation === 'SEARCH' ? 'Sin término registrado' : '—'),
    day: timestamp.split(' ')[0] || '—',
    time: timestamp.split(' ')[1] || '—',
  };
}
