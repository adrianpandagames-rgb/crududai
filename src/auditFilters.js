import { auditActionLabels, auditResources, auditOperationSql, auditResourceSql } from './auditActions.js';
export { auditActionLabels } from './auditActions.js';

// The server and MySQL run in UTC; people read and filter the log in Sonora time.
export const AUDIT_TIME_ZONE = 'America/Hermosillo';
export const AUDIT_PAGE_SIZE = 50;

// Requests the pages make by themselves, plus the public landing page. New entries are no longer
// written for them (see auditMiddleware.js); older ones stay hidden unless "automaticas" is checked.
export const automaticAuditPaths = ['/', '/api/localidades', '/api/ubicaciones/heatmap', '/medidores/resumen'];

export const auditResults = {
  OK: 'Correcto', DENEGADO: 'Acceso denegado', RECHAZADO: 'Solicitud rechazada', ERROR: 'Error del servidor',
};
export const auditResultSql = `CASE
  WHEN status_code >= 500 THEN 'ERROR'
  WHEN status_code IN (401, 403, 429) THEN 'DENEGADO'
  WHEN status_code >= 400 THEN 'RECHAZADO'
  ELSE 'OK' END`;

export const auditOrigins = { WEB: 'Página web', TELEGRAM: 'Telegram' };
const telegramSql = `details LIKE '%"origen":"Telegram"%'`;

const zoneOffsetMs = (epochMs) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: AUDIT_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs)).map(({ type, value }) => [type, value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
};

// Epoch seconds of 00:00 on `day` (YYYY-MM-DD) in the audit time zone.
export function auditDayStart(day) {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  return Math.floor((midnightUtc - zoneOffsetMs(midnightUtc)) / 1000);
}

// "YYYY-MM-DD HH:MM:SS" in the audit time zone, from epoch seconds.
export function formatAuditTimestamp(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined || epochSeconds === '') return '';
  const epochMs = Number(epochSeconds) * 1000;
  if (!Number.isFinite(epochMs)) return '';
  return new Date(epochMs + zoneOffsetMs(epochMs)).toISOString().slice(0, 19).replace('T', ' ');
}

const filterKeys = ['desde', 'hasta', 'tipo', 'accion', 'usuario', 'resultado', 'origen', 'ip', 'texto', 'automaticas'];

export function buildAuditFilters(query = {}) {
  const filters = {};
  for (const key of filterKeys) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      throw new Error('Los filtros deben contener un solo valor.');
    }
    filters[key] = (query[key] || '').trim();
  }
  for (const key of ['desde', 'hasta']) {
    const value = filters[key];
    if (!value) continue;
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-02' || value > '9999-12-30'
      || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error('Ingresa fechas válidas.');
    }
  }
  if (filters.desde && filters.hasta && filters.desde > filters.hasta) {
    throw new Error('La fecha inicial no puede ser posterior a la fecha final.');
  }
  if (filters.tipo && !Object.hasOwn(auditResources, filters.tipo)) {
    throw new Error('Selecciona un tipo válido.');
  }
  if (filters.accion && !Object.hasOwn(auditActionLabels, filters.accion)) {
    throw new Error('Selecciona una acción válida.');
  }
  if (filters.resultado && !Object.hasOwn(auditResults, filters.resultado)) {
    throw new Error('Selecciona un resultado válido.');
  }
  if (filters.origen && !Object.hasOwn(auditOrigins, filters.origen)) {
    throw new Error('Selecciona un origen válido.');
  }
  if (filters.usuario.length > 255) throw new Error('El usuario es demasiado largo.');
  if (filters.ip.length > 45) throw new Error('La IP es demasiado larga.');
  if (filters.texto.length > 100) throw new Error('El texto a buscar es demasiado largo.');
  filters.automaticas = filters.automaticas === '1' ? '1' : '';

  const clauses = [];
  const values = [];
  // FROM_UNIXTIME and the TIMESTAMP column are both read in the session time zone, so the
  // comparison holds whatever zone MySQL uses.
  if (filters.desde) { clauses.push('created_at >= FROM_UNIXTIME(?)'); values.push(auditDayStart(filters.desde)); }
  if (filters.hasta) {
    const next = new Date(`${filters.hasta}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    clauses.push('created_at < FROM_UNIXTIME(?)');
    values.push(auditDayStart(next.toISOString().slice(0, 10)));
  }
  if (filters.tipo) {
    clauses.push(`(${auditResourceSql}) = ?`);
    values.push(filters.tipo);
  }
  if (filters.accion) {
    clauses.push(`(${auditOperationSql}) = ?`);
    values.push(filters.accion);
  }
  if (filters.resultado) {
    clauses.push(`(${auditResultSql}) = ?`);
    values.push(filters.resultado);
  }
  if (filters.origen === 'TELEGRAM') clauses.push(telegramSql);
  if (filters.origen === 'WEB') clauses.push(`(details IS NULL OR NOT ${telegramSql})`);
  if (filters.usuario) { clauses.push('user_email = ?'); values.push(filters.usuario); }
  if (filters.ip) { clauses.push('ip_address = ?'); values.push(filters.ip); }
  if (filters.texto) {
    const term = `%${filters.texto.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    clauses.push('(request_path LIKE ? OR details LIKE ? OR user_email LIKE ?)');
    values.push(term, term, term);
  }
  if (!filters.automaticas) {
    clauses.push(`SUBSTRING_INDEX(request_path, '?', 1) NOT IN (${automaticAuditPaths.map(() => '?').join(', ')})`);
    values.push(...automaticAuditPaths);
  }
  return { filters, where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

// Query string for the current filters, without empty values, for links and pagination.
export function auditFilterQuery(filters, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== '' && value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}
