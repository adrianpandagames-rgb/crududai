import express from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { forwardAsyncErrors } from './errorHandling.js';
import { listarUbicacionesParaRuta } from "./estudianteController.js";
import { createRutaCsv, createRutaXlsx, getRutaXlsxMetadata, processRutaCsv, processRutaXlsx } from "./rutaService.js";
import pool from "./db.js";
import { fileGroupOf, visibleFiles } from './fileGroups.js';

const RUTA_MAX_FILE_SIZE = 20 * 1024 * 1024;
const uploadStorage = multer.memoryStorage();
const rutaUploadParser = multer({ storage: uploadStorage, limits: { fileSize: RUTA_MAX_FILE_SIZE } });
const RUTA_PROCESSING_DELAY_MS = 10000;
const router = forwardAsyncErrors(express.Router());
const rutaStorageReady = pool.query(`
  CREATE TABLE IF NOT EXISTS ruta_archivos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    file_uuid CHAR(36) NOT NULL UNIQUE,
    line_number VARCHAR(50) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    source_metadata JSON NULL,
    status VARCHAR(20) NOT NULL,
    result_csv LONGTEXT NULL,
    source_file LONGBLOB NULL,
    row_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_message VARCHAR(500) NULL,
    user_id BIGINT NULL,
    owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    INDEX ruta_archivos_expires_at_index (expires_at)
  )
`).then(async () => {
  try {
    await pool.query('ALTER TABLE ruta_archivos ADD COLUMN source_metadata JSON NULL');
  } catch (error) {
    if (!/duplicate column/i.test(error.message || '')) throw error;
  }
  try {
    await pool.query('ALTER TABLE ruta_archivos ADD COLUMN source_file LONGBLOB NULL');
  } catch (error) {
    if (!/duplicate column/i.test(error.message || '')) throw error;
  }
  // Files uploaded before groups existed have no uploader, so they stay in the general group.
  try {
    await pool.query('ALTER TABLE ruta_archivos ADD COLUMN user_id BIGINT NULL');
  } catch (error) {
    if (!/duplicate column/i.test(error.message || '')) throw error;
  }
  try {
    await pool.query("ALTER TABLE ruta_archivos ADD COLUMN owner_group VARCHAR(10) NOT NULL DEFAULT 'general'");
  } catch (error) {
    if (!/duplicate column/i.test(error.message || '')) throw error;
  }
  return true;
});

const cleanExpiredRutaFiles = async () => {
  await rutaStorageReady;
  await pool.query('DELETE FROM ruta_archivos WHERE expires_at <= NOW()');
};

const processRutaFile = async (job, buffer, extension, sourceMetadata, notification = null) => {
  try {
    const locations = await listarUbicacionesParaRuta();
    const rows = extension === '.xlsx'
      ? processRutaXlsx(buffer, locations)
      : processRutaCsv(buffer.toString('utf8'), locations);
    const resultCsv = '\uFEFF' + createRutaCsv(rows);
    await pool.execute(
      `UPDATE ruta_archivos
      SET status = 'listo', result_csv = ?, source_metadata = ?, row_count = ?, error_message = NULL
       WHERE file_uuid = ? AND expires_at > NOW()`,
          [resultCsv, sourceMetadata ? JSON.stringify(sourceMetadata) : null, Math.max(rows.length - 1, 0), job.id],
    );

    if (notification?.userId && notification?.pendingToasts) {
      notification.pendingToasts.set(notification.userId, {
        message: 'El archivo se procesó correctamente.',
        fileId: job.id,
      });
    }
  } catch (error) {
    await pool.execute(
      `UPDATE ruta_archivos
       SET status = 'error', error_message = ?
       WHERE file_uuid = ? AND expires_at > NOW()`,
      [error.message || 'No fue posible procesar el archivo.', job.id],
    ).catch((updateError) => console.error('Unable to update Ruta file:', updateError.message));
  }
};

const resumePendingRutaFiles = async () => {
  await rutaStorageReady;
  await pool.query(
    `UPDATE ruta_archivos
     SET status = 'error', error_message = 'El archivo no puede reanudarse porque fue cargado antes de habilitar el almacenamiento persistente.'
     WHERE status = 'pendiente' AND source_file IS NULL`,
  );

  const [jobs] = await pool.query(
    `SELECT file_uuid, original_name, source_file, source_metadata
     FROM ruta_archivos
     WHERE status = 'pendiente' AND source_file IS NOT NULL AND expires_at > NOW()
     ORDER BY created_at ASC`,
  );

  for (const job of jobs) {
    const extension = path.extname(job.original_name).toLowerCase();
    await processRutaFile(
      { id: job.file_uuid },
      job.source_file,
      extension,
      job.source_metadata,
    );
  }
};

resumePendingRutaFiles().catch((error) => {
  console.error('Unable to resume pending Ruta files:', error.message);
});

const rutaUpload = (req, res, next) => {
  rutaUploadParser.single('archivo')(req, res, (error) => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'El archivo supera el límite de 20 MB.'
      : 'No fue posible leer el archivo enviado.';
    return res.redirect('/ruta?message=' + encodeURIComponent(message) + '&type=error');
  });
};

router.get('/ruta', (req, res, next) => {
  Promise.resolve()
    .then(() => cleanExpiredRutaFiles())
    .then(async () => {
      const scope = visibleFiles(req.session, 'r');
      const [files] = await pool.query(
        `SELECT r.file_uuid AS id, r.line_number AS lineNumber, r.original_name AS name,
                r.status, r.row_count AS \`rows\`, r.error_message AS error
         FROM ruta_archivos r
         WHERE ${scope.where}
         ORDER BY r.created_at DESC, r.id DESC`,
        scope.values,
      );
      res.render('pages/ruta', {
        files,
        message: req.query.message || null,
        messageType: req.query.type || null,
        highlightId: req.query.highlight || null,
      });
    })
    .catch(next);
});

router.post('/ruta/importar', rutaUpload, async (req, res) => {
  if (!req.file) return res.redirect('/ruta?message=' + encodeURIComponent('Selecciona un archivo CSV.') + '&type=error');
  const lineNumber = String(req.body.linea || '').trim();
  if (!lineNumber) return res.redirect('/ruta?message=' + encodeURIComponent('Ingresa el número de línea.') + '&type=error');
  if (lineNumber.length > 50) return res.redirect('/ruta?message=' + encodeURIComponent('El número de línea es demasiado largo.') + '&type=error');

  const extension = path.extname(req.file.originalname).toLowerCase();
  if (!['.csv', '.xlsx'].includes(extension)) {
    return res.redirect('/ruta?message=' + encodeURIComponent('El archivo debe ser CSV o Excel (.xlsx).') + '&type=error');
  }

  const id = crypto.randomUUID();
  const sourceMetadata = extension === '.xlsx' ? getRutaXlsxMetadata(req.file.buffer) : null;
  await cleanExpiredRutaFiles();
  await pool.execute(
    `INSERT INTO ruta_archivos
       (file_uuid, line_number, original_name, source_metadata, source_file, status, user_id, owner_group, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, DATE_ADD(NOW(), INTERVAL 2 DAY))`,
    [id, lineNumber, req.file.originalname, sourceMetadata ? JSON.stringify(sourceMetadata) : null, req.file.buffer,
      req.session?.userId ?? null, fileGroupOf(req.session)],
  );
  const job = { id };
  const notification = {
    userId: req.session?.userId,
    pendingToasts: req.app.locals.pendingRouteToasts,
  };
  setTimeout(() => processRutaFile(job, req.file.buffer, extension, sourceMetadata, notification), RUTA_PROCESSING_DELAY_MS);

  return res.redirect('/ruta?message=' + encodeURIComponent('Archivo recibido y enviado a procesamiento.') + '&type=success');
});

router.post('/ruta/eliminar/:id', async (req, res) => {
  try {
    await cleanExpiredRutaFiles();
    const scope = visibleFiles(req.session, 'r');
    const [result] = await pool.execute(
      `DELETE r FROM ruta_archivos r WHERE r.file_uuid = ? AND ${scope.where}`,
      [req.params.id, ...scope.values],
    );
    const message = result.affectedRows === 1
      ? 'Archivo eliminado correctamente.'
      : 'El archivo no fue encontrado.';
    const type = result.affectedRows === 1 ? 'success' : 'error';
    return res.redirect('/ruta?message=' + encodeURIComponent(message) + '&type=' + type);
  } catch (error) {
    return res.redirect('/ruta?message=' + encodeURIComponent('No fue posible eliminar el archivo.') + '&type=error');
  }
});

router.get('/ruta/exportar/:id', async (req, res) => {
  try {
    await cleanExpiredRutaFiles();
    const scope = visibleFiles(req.session, 'r');
    const [files] = await pool.execute(
      `SELECT r.line_number, r.status, r.result_csv, r.source_metadata
       FROM ruta_archivos r
       WHERE r.file_uuid = ? AND ${scope.where} AND r.expires_at > NOW()
       LIMIT 1`,
      [req.params.id, ...scope.values],
    );
    const file = files[0];
    if (!file || file.status !== 'listo' || !file.result_csv) return res.status(404).send('El archivo todavía no está listo.');
    const lineNumber = String(file.line_number).replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Geoposicionamiento-${lineNumber}.csv"`);
    return res.send(file.result_csv);
  } catch (error) {
    return res.status(500).send('No fue posible exportar el archivo.');
  }
});

router.get('/ruta/exportar-xlsx/:id', async (req, res) => {
  try {
    await cleanExpiredRutaFiles();
    const scope = visibleFiles(req.session, 'r');
    const [files] = await pool.execute(
      `SELECT r.line_number, r.status, r.result_csv, r.source_metadata
       FROM ruta_archivos r
       WHERE r.file_uuid = ? AND ${scope.where} AND r.expires_at > NOW()
       LIMIT 1`,
      [req.params.id, ...scope.values],
    );
    const file = files[0];
    if (!file || file.status !== 'listo' || !file.result_csv) return res.status(404).send('El archivo todavía no está listo.');
    const lineNumber = String(file.line_number).replace(/[^a-zA-Z0-9_-]/g, '_');
    const sourceMetadata = typeof file.source_metadata === 'string'
      ? JSON.parse(file.source_metadata)
      : (file.source_metadata || {});
    const xlsx = createRutaXlsx(file.result_csv, sourceMetadata);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Geoposicionamiento-${lineNumber}.xlsx"`);
    return res.send(xlsx);
  } catch (error) {
    return res.status(500).send('No fue posible exportar el archivo Excel.');
  }
});

export default router;
