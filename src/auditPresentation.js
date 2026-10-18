import { sanitizeAuditData } from './auditDetails.js';

const auxiliary = new Set(['page', 'pagina', 'pageSize', 'partial', 'message', 'toastMessage']);

export function presentAuditEntry(entry) {
  let details = entry.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = null; }
  }
  details = sanitizeAuditData(details);
  const legacyQuery = Object.fromEntries(new URLSearchParams(String(entry.request_path || '').split('?').slice(1).join('?')));
  const parameters = sanitizeAuditData({ ...legacyQuery, ...details?.parametros, ...details?.datos });
  const searched = Object.entries(parameters).filter(([key, value]) =>
    !auxiliary.has(key) && value !== '[OCULTO]' && value !== '' && value !== null && value !== undefined);
  const timestamp = String(entry.createdAt || '');
  return {
    ...entry,
    details,
    origin: details?.origen === 'Telegram' ? `Telegram · /${details.comando || ''}` : 'Página web',
    searched: searched.map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ')
      || (entry.operation === 'SEARCH' ? 'Sin término registrado' : '—'),
    day: timestamp.split(' ')[0] || '—',
    time: timestamp.split(' ')[1] || '—',
  };
}
