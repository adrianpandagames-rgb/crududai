import pool from './db.js';

export function requireRecordCreator(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  if (req.session.role === 'uecs') {
    return res.status(403).json({ error: 'UECS solo puede buscar y consultar registros en Líneas, IMEI y Ubicaciones.' });
  }
  return next();
}

export const requireRecordEditor = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/');
  }
  try {
    const [rows] = await pool.execute('SELECT is_admin, role FROM users WHERE id = ?', [req.session.userId]);
    const canEditRecords = rows.length === 1 && (Number(rows[0].is_admin) === 1 || rows[0].role === 'admin' || rows[0].role === 'semiadmin');
    if (!canEditRecords) {
      return res.status(403).redirect('/Crud');
    }
    return next();
  } catch (error) {
    return next(error);
  }
};
