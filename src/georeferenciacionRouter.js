import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeGeocodingLocations, saveGeocodingLocation, listGeocodingLocations } from './georeferenciacionUbicaciones.js';
import { createRutaCsv, createRutaXlsx, getRutaXlsxMetadata } from './rutaService.js';
import { getGeocodingKey, readGeocodingFile, processGeocodingFile } from './georeferenciacionService.js';

export function createGeoreferenciacionRouter(pool) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1 } }).single('archivo');
  const jobs = new Map();
  let queue = Promise.resolve();
  let storage;
  const initialize = () => {
    if (!storage) storage = (async () => {
      await initializeGeocodingLocations(pool);
      await pool.query(`CREATE TABLE IF NOT EXISTS georeferenciacion_archivos (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        file_uuid CHAR(36) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL,
        line_number VARCHAR(50) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        source_metadata JSON NULL,
        status VARCHAR(20) NOT NULL,
        result_csv LONGTEXT NULL,
        row_count INT UNSIGNED NOT NULL DEFAULT 0,
        processed_rows INT UNSIGNED NOT NULL DEFAULT 0,
        error_message VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        INDEX geo_user_expiry (user_id, expires_at)
      )`);
      await pool.query(`UPDATE georeferenciacion_archivos SET status = 'error',
        error_message = 'El servidor se reinició. Importa nuevamente el archivo para continuar.'
        WHERE status = 'pendiente'`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };
  const redirect = (res, message, type = 'error') => res.redirect('/georeferenciacion?' + new URLSearchParams({ message, type }));
  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    if (req.session.isAdmin !== true) return res.status(403).send('Georeferenciación está disponible solo para administradores.');
    res.setHeader('Cache-Control', 'no-store');
    try {
      await initialize();
      await pool.query('DELETE FROM georeferenciacion_archivos WHERE expires_at <= NOW()');
      next();
    } catch {
      res.status(503).send('No fue posible acceder a los archivos de Georeferenciación.');
    }
  });
  router.get('/', async (req, res) => {
    try {
      const [files] = await pool.execute(`SELECT file_uuid AS id, line_number AS lineNumber,
        original_name AS name, status, error_message AS error, row_count AS total,
        processed_rows AS processed FROM georeferenciacion_archivos
        WHERE user_id = ? AND expires_at > NOW() ORDER BY id DESC`, [req.session.userId]);
      res.render('pages/georeferenciacion', {
        ...await listGeocodingLocations(pool, req.query),
        files, configured: Boolean(getGeocodingKey()),
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch {
      res.status(500).send('No fue posible listar los archivos de Georeferenciación.');
    }
  });
  router.post('/importar', (req, res, next) => {
    if (!getGeocodingKey()) return redirect(res, 'Falta configurar GOOGLE_GEOCODING_API_KEY en el servidor.');
    if (jobs.size >= 20) return redirect(res, 'La cola está llena. Espera a que finalicen los archivos en proceso.');
    upload(req, res, (error) => error
      ? redirect(res, error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 20 MB.' : 'No fue posible recibir el archivo.')
      : next());
  }, async (req, res) => {
    if (!req.file) return redirect(res, 'Selecciona un archivo CSV o Excel (.xlsx).');
    const line = String(req.body.linea || '').trim();
    if (!line || line.length > 50) return redirect(res, 'Ingresa un número de línea de hasta 50 caracteres.');
    const extension = path.extname(req.file.originalname).toLowerCase();
    if (!['.csv', '.xlsx'].includes(extension)) return redirect(res, 'El archivo debe ser CSV o Excel (.xlsx).');
    let input;
    let metadata;
    try {
      input = readGeocodingFile(req.file.buffer, extension);
      metadata = extension === '.xlsx' ? getRutaXlsxMetadata(req.file.buffer) : {};
    } catch {
      return redirect(res, 'No se pudo leer el archivo. Verifica que tenga datos, columnas latitud y longitud y un máximo de 100000 filas.');
    }
    const id = crypto.randomUUID();
    const controller = new AbortController();
    try {
      await pool.execute(`INSERT INTO georeferenciacion_archivos
        (file_uuid, user_id, line_number, original_name, source_metadata, status, row_count, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pendiente', ?, DATE_ADD(NOW(), INTERVAL 2 DAY))`,
      [id, req.session.userId, line, req.file.originalname.slice(0, 255), JSON.stringify(metadata), input.rows.length - 1]);
    } catch {
      return redirect(res, 'No fue posible guardar el archivo.');
    }
    jobs.set(id, { controller, userId: req.session.userId });
    queue = queue.then(async () => {
      try {
        const [files] = await pool.execute('SELECT file_uuid FROM georeferenciacion_archivos WHERE file_uuid = ? AND expires_at > NOW()', [id]);
        if (!files.length || controller.signal.aborted) return;
        const rows = await processGeocodingFile(input, {
          onLocation: (location) => saveGeocodingLocation(pool, location),
          signal: controller.signal,
          onProgress: async (processed) => {
            const [result] = await pool.execute(`UPDATE georeferenciacion_archivos SET processed_rows = ?
              WHERE file_uuid = ? AND expires_at > NOW()`, [processed, id]);
            if (!result.affectedRows) controller.abort();
          },
        });
        await pool.execute(`UPDATE georeferenciacion_archivos SET status = 'listo', result_csv = ?
          WHERE file_uuid = ? AND expires_at > NOW()`, ['\uFEFF' + createRutaCsv(rows), id]);
      } catch (error) {
        await pool.execute(`UPDATE georeferenciacion_archivos SET status = 'error', error_message = ?
          WHERE file_uuid = ?`, [error.message.slice(0, 500), id]).catch(() => {});
      } finally {
        jobs.delete(id);
      }
    });
    return redirect(res, 'Archivo recibido. Se consultarán sus coordenadas en Google Geocoding.', 'success');
  });
  router.post('/eliminar/:id', async (req, res) => {
    try {
      const job = jobs.get(req.params.id);
      if (job?.userId === req.session.userId) job.controller.abort();
      const [result] = await pool.execute('DELETE FROM georeferenciacion_archivos WHERE file_uuid = ? AND user_id = ?', [req.params.id, req.session.userId]);
      return redirect(res, result.affectedRows ? 'Archivo eliminado.' : 'Archivo no encontrado.', result.affectedRows ? 'success' : 'error');
    } catch {
      return redirect(res, 'No fue posible eliminar el archivo.');
    }
  });
  for (const format of ['csv', 'xlsx']) {
    router.get(`/${format === 'csv' ? 'exportar' : 'exportar-xlsx'}/:id`, async (req, res) => {
      try {
        const [files] = await pool.execute(`SELECT line_number, result_csv, source_metadata
          FROM georeferenciacion_archivos WHERE file_uuid = ? AND user_id = ?
          AND status = 'listo' AND expires_at > NOW()`, [req.params.id, req.session.userId]);
        const file = files[0];
        if (!file) return res.status(404).send('Archivo no encontrado o todavía no disponible.');
        const metadata = typeof file.source_metadata === 'string' ? JSON.parse(file.source_metadata) : file.source_metadata || {};
        const body = format === 'csv' ? file.result_csv : createRutaXlsx(file.result_csv, metadata);
        res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.attachment(`Georeferenciacion-${file.line_number.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`);
        res.send(body);
      } catch {
        res.status(500).send('No fue posible exportar el archivo.');
      }
    });
  }
  return router;
}
