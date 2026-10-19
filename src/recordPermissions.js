export function requireRecordCreator(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Inicia sesi?n para continuar.' });
  if (req.session.role === 'uecs') {
    return res.status(403).json({ error: 'UECS solo puede buscar y consultar registros en L?neas, IMEI y Ubicaciones.' });
  }
  return next();
}
