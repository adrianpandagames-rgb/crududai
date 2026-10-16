const sensitiveField = /password|passwd|contrase[nñ]a|token|secret|api[_-]?key|authorization|cookie/i;

export function sanitizeAuditData(value) {
  if (Array.isArray(value)) return value.map(sanitizeAuditData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, sensitiveField.test(key) ? '[OCULTO]' : sanitizeAuditData(item),
    ]));
  }
  return value;
}

export function buildAuditDetails(req) {
  const details = {};
  if (req.body && Object.keys(req.body).length) details.datos = sanitizeAuditData(req.body);
  if (req.query && Object.keys(req.query).length) details.parametros = sanitizeAuditData(req.query);
  const files = req.file ? [req.file] : Array.isArray(req.files)
    ? req.files : Object.values(req.files || {}).flat();
  if (files.length) details.archivos = files.map(file => ({
    campo: file.fieldname, nombre: file.originalname, tipo: file.mimetype, bytes: file.size,
  }));
  return Object.keys(details).length ? details : null;
}
