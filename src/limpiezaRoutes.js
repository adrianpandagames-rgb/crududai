// Limpieza: upload a carrier's sábana, keep the two cleaned Excel files for two days and offer them for download.
import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { forwardAsyncErrors } from './errorHandling.js';
import pool from './db.js';
import { fileGroupOf, visibleFiles } from './fileGroups.js';
import { XlsxTooLargeError } from './xlsxSafe.js';
import { procesarSabana } from './limpiezaService.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });
const router = forwardAsyncErrors(express.Router());

const storageReady = pool.query(`
  CREATE TABLE IF NOT EXISTS limpieza_archivos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    file_uuid CHAR(36) NOT NULL UNIQUE,
    original_name VARCHAR(255) NOT NULL,
    line_number VARCHAR(50) NOT NULL DEFAULT '',
    resumen JSON NULL,
    sabana_xlsx LONGBLOB NOT NULL,
    geo_xlsx LONGBLOB NOT NULL,
    user_id BIGINT NULL,
    owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    INDEX limpieza_archivos_expires_at_index (expires_at)
  )
`);

const cleanExpired = async () => {
  await storageReady;
  await pool.query('DELETE FROM limpieza_archivos WHERE expires_at <= NOW()');
};

const back = (res, message, type) => res.redirect(`/limpieza?message=${encodeURIComponent(message)}&type=${type}`);

const receive = (req, res, next) => {
  upload.single('archivo')(req, res, (error) => {
    if (!error) return next();
    return back(res, error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 20 MB.' : 'No fue posible leer el archivo enviado.', 'error');
  });
};

const parseResumen = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return value;
};

router.get('/limpieza', async (req, res) => {
  await cleanExpired();
  const scope = visibleFiles(req.session, 'l');
  const [rows] = await pool.query(
    `SELECT l.file_uuid AS id, l.original_name AS name, l.line_number AS lineNumber, l.resumen
     FROM limpieza_archivos l
     WHERE ${scope.where}
     ORDER BY l.created_at DESC, l.id DESC`,
    scope.values,
  );
  res.render('pages/limpieza', {
    files: rows.map((row) => ({ ...row, resumen: parseResumen(row.resumen) })),
    message: req.query.message || null,
    messageType: req.query.type || null,
    highlightId: req.query.highlight || null,
  });
});

router.post('/limpieza/subir', receive, async (req, res) => {
  if (!req.file) return back(res, 'Selecciona la sábana (CSV o Excel).', 'error');
  const extension = path.extname(req.file.originalname).toLowerCase();
  if (!['.csv', '.xlsx'].includes(extension)) return back(res, 'La sábana debe ser CSV o Excel (.xlsx).', 'error');

  let result;
  try {
    result = procesarSabana(req.file.buffer, extension, req.file.originalname);
  } catch (error) {
    const known = error instanceof XlsxTooLargeError || /^(No se encontró|El archivo|El CSV)/.test(error.message || '');
    return back(res, known ? error.message : 'No fue posible leer la sábana.', 'error');
  }

  const id = crypto.randomUUID();
  await cleanExpired();
  await pool.execute(
    `INSERT INTO limpieza_archivos
       (file_uuid, original_name, line_number, resumen, sabana_xlsx, geo_xlsx, user_id, owner_group, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 2 DAY))`,
    [id, req.file.originalname.slice(0, 255), String(result.resumen.linea || '').slice(0, 50),
      JSON.stringify({ ...result.resumen, imeis: undefined, porTipo: undefined }),
      result.sabana, result.geo, req.session?.userId ?? null, fileGroupOf(req.session)],
  );
  const { espejos, registrosReales } = result.resumen;
  return res.redirect(`/limpieza?message=${encodeURIComponent(`Sábana limpia: ${espejos} llamadas espejo quitadas, ${registrosReales} registros reales.`)}&type=success&highlight=${id}`);
});

const DOWNLOADS = {
  sabana: { column: 'sabana_xlsx', name: (line) => `Sabana-limpia-${line}.xlsx` },
  geo: { column: 'geo_xlsx', name: (line) => `Geoposicionamiento-limpio-${line}.xlsx` },
};

router.get('/limpieza/descargar/:id/:tipo', async (req, res) => {
  const download = Object.hasOwn(DOWNLOADS, req.params.tipo) ? DOWNLOADS[req.params.tipo] : null;
  if (!download) return res.status(404).send('Descarga no encontrada.');
  await cleanExpired();
  const scope = visibleFiles(req.session, 'l');
  const [rows] = await pool.execute(
    `SELECT l.line_number, l.${download.column} AS file
     FROM limpieza_archivos l
     WHERE l.file_uuid = ? AND ${scope.where} AND l.expires_at > NOW()
     LIMIT 1`,
    [req.params.id, ...scope.values],
  );
  if (!rows[0]) return res.status(404).send('El archivo ya no está disponible.');
  const line = String(rows[0].line_number || 'sabana').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${download.name(line)}"`);
  return res.send(rows[0].file);
});

router.post('/limpieza/eliminar/:id', async (req, res) => {
  await cleanExpired();
  const scope = visibleFiles(req.session, 'l');
  const [result] = await pool.execute(
    `DELETE l FROM limpieza_archivos l WHERE l.file_uuid = ? AND ${scope.where}`,
    [req.params.id, ...scope.values],
  );
  return result.affectedRows === 1
    ? back(res, 'Archivo eliminado correctamente.', 'success')
    : back(res, 'El archivo no fue encontrado.', 'error');
});

export default router;
