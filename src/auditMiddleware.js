import { auditRequestPath } from './auditActions.js';
import { buildAuditDetails } from './auditDetails.js';
import { automaticAuditPaths } from './auditFilters.js';

const mutations = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const backgroundPaths = new Set(['/health', '/health/ready', '/api/route-toast', ...automaticAuditPaths]);
const presentationParameters = new Set(['page', 'pagina', 'pageSize', 'partial', 'message', 'type', 'toastMessage']);

// Inside a mounted router req.path loses its prefix ("/planeacion-geografica/importar" reads "/importar"),
// and the finish event can fire before Express restores it, so the full path comes from originalUrl.
const fullPath = (req) => (req.originalUrl ? req.originalUrl.split('?')[0] : req.path) || '/';

export function auditRequestAction(req) {
  const path = fullPath(req);
  if (backgroundPaths.has(path) || path.startsWith('/public/')) return null;
  if (req.method === 'GET') {
    const filtered = Object.entries(req.query || {}).some(([key, value]) =>
      !presentationParameters.has(key) && String(value ?? '').trim() !== '');
    return filtered || /\/(buscar|search|consulta)(\/|$)/i.test(path) ? 'SEARCH' : 'CONSULTA';
  }
  if (req.method === 'POST' && (/\/(buscar|search|consulta)(\/|$)/i.test(path) || path === '/api/telefono/validar')) return 'SEARCH';
  return mutations.has(req.method) ? req.method : null;
}

// Registered before the routes; authentication and multipart parsers populate
// the session/body/files before the response finishes.
export function auditActivity(req, res, next) {
  res.on('finish', () => {
    const action = auditRequestAction(req);
    if (!action || !req.session || req.auditTelegram) return;
    req.app.locals.writeAuditLog?.({
      userId: req.session.userId,
      userEmail: req.session.email,
      action,
      requestPath: auditRequestPath(fullPath(req), req.query),
      statusCode: res.statusCode,
      ipAddress: req.ip,
      details: { ...(buildAuditDetails(req) || {}), metodo: req.method },
    });
  });
  next();
}
