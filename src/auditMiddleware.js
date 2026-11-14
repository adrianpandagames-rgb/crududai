import { auditRequestPath, exportPathPattern } from './auditActions.js';
import { describirCambios, describirRegistro, registroAuditado, registroDeSolicitud } from './auditCambios.js';
import { buildAuditDetails } from './auditDetails.js';
import { automaticAuditPaths } from './auditFilters.js';

const mutations = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// The task board's live stream and the column refreshes it triggers are not the user's actions, and neither is
// arranging a table's columns, which saves after every drag, nor the browser checking the app's service worker.
// Downloads built in the browser report themselves to /auditoria/exportacion, which writes its own entry.
const backgroundPaths = new Set(['/health', '/health/ready', '/api/route-toast', '/tareas/eventos', '/tareas/tablero', '/cuenta/tablas', '/sw.js',
  '/auditoria/exportacion', '/cuenta/dos-pasos/opciones', ...automaticAuditPaths]);
const presentationParameters = new Set(['page', 'pagina', 'pageSize', 'partial', 'message', 'type', 'toastMessage']);

// Inside a mounted router req.path loses its prefix ("/planeacion-geografica/importar" reads "/importar"),
// and the finish event can fire before Express restores it, so the full path comes from originalUrl.
const fullPath = (req) => (req.originalUrl ? req.originalUrl.split('?')[0] : req.path) || '/';

export function auditRequestAction(req) {
  const path = fullPath(req);
  if (backgroundPaths.has(path) || path.startsWith('/public/')) return null;
  if (req.method === 'GET') {
    if (exportPathPattern.test(path)) return 'EXPORT';
    const filtered = Object.entries(req.query || {}).some(([key, value]) =>
      !presentationParameters.has(key) && String(value ?? '').trim() !== '');
    // Only searches are logged; opening a page is not an action on the data.
    return filtered || /\/(buscar|search|consulta)(\/|$)/i.test(path) ? 'SEARCH' : null;
  }
  if (req.method === 'POST' && (/\/(buscar|search|consulta)(\/|$)/i.test(path) || path === '/api/telefono/validar')) return 'SEARCH';
  return mutations.has(req.method) ? req.method : null;
}

const uploadedFiles = (req) => (req.file ? [req.file] : Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat());

// Registered before the routes; authentication and multipart parsers populate the session/body/files before
// the response finishes. A request that edits or deletes a listed record (auditCambios.js) waits for that
// record to be read first, so the entry can show its values before and after.
export function auditActivity(req, res, next) {
  const action = auditRequestAction(req);
  const path = fullPath(req);
  const { auditPool, auditSession } = req.app.locals;
  const registro = action && action !== 'SEARCH'
    ? registroAuditado(req, path, { pool: auditPool, ...auditSession?.(req) }) : null;
  const antes = registro && registro.tipo !== 'exportar' ? registro.leer() : null;

  const write = (extra = {}) => {
    req.app.locals.writeAuditLog?.({
      userId: req.session.userId,
      userEmail: req.session.email,
      action,
      requestPath: auditRequestPath(path, req.query),
      statusCode: res.statusCode,
      ipAddress: req.ip,
      registro: action === 'EXPORT' || mutations.has(req.method) ? registroDeSolicitud(path, req.body, uploadedFiles(req)) : null,
      details: { ...(buildAuditDetails(req) || {}), metodo: req.method },
      ...extra,
    });
  };

  res.on('finish', () => {
    if (!action || !req.session || req.auditTelegram) return;
    if (!registro) return write();
    Promise.all([antes, registro.leer()]).then(([before, after]) => write({
      registro: describirRegistro(registro, before, after),
      cambios: describirCambios(registro.tipo, before, after),
    })).catch(() => write());
  });
  if (!antes) return next();
  return antes.then(() => next());
}
