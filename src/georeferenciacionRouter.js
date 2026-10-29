import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeLocalRoads, createLocalCrossStreetLookup, getLocalRoadStatus } from './redVialLocal.js';
import { initializeGeocodingLocations, saveGeocodingLocation, listGeocodingLocations, findGeocodingLocation } from './georeferenciacionUbicaciones.js';
import { createRutaCsv, createRutaXlsx, getRutaXlsxMetadata } from './rutaService.js';
import { getGeocodingKey, readGeocodingFile, processGeocodingFile, reverseGeocode } from './georeferenciacionService.js';
import { getGoogleGeocodingQuota, reserveGoogleGeocodingRequest } from './googleGeocodingQuota.js';
import { fileGroupOf, visibleFiles as visibleFilesFor } from './fileGroups.js';

const visibleFiles = (session) => visibleFilesFor(session, 'g');

export function createGeoreferenciacionRouter(pool) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1 } }).single('archivo');
  const jobs = new Map();
  let queue = Promise.resolve();
  let storage;
  const initialize = () => {
    if (!storage) storage = (async () => {
      await initializeGeocodingLocations(pool);
      await initializeLocalRoads(pool);
      await getGoogleGeocodingQuota(pool);
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
        owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        INDEX geo_user_expiry (user_id, expires_at)
      )`);
      try {
        await pool.query("ALTER TABLE georeferenciacion_archivos ADD COLUMN owner_group VARCHAR(10) NOT NULL DEFAULT 'general'");
        // Existing files take the group their uploader belongs to today.
        await pool.query(`UPDATE georeferenciacion_archivos g INNER JOIN users u ON u.id = g.user_id
          SET g.owner_group = 'uecs' WHERE u.role = 'uecs' AND COALESCE(u.is_admin, 0) <> 1`);
      } catch (error) {
        if (!/duplicate column/i.test(error.message || '')) throw error;
      }
      await pool.query(`UPDATE georeferenciacion_archivos SET status = 'error',
        error_message = 'El servidor se reinició. Importa nuevamente el archivo para continuar.'
        WHERE status = 'pendiente'`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };
  const redirect = (res, message, type = 'error') => res.redirect('/georeferenciacion?' + new URLSearchParams({ message, type }));
  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    if (req.session.isAdmin !== true && req.session.role !== 'uecs') {
      return res.status(403).send('Georeferenciación está disponible solo para administradores y usuarios UECS.');
    }
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
      const scope = visibleFiles(req.session);
      const [files] = await pool.execute(`SELECT g.file_uuid AS id, g.line_number AS lineNumber,
        g.original_name AS name, g.status, g.error_message AS error, g.row_count AS total,
        g.processed_rows AS processed FROM georeferenciacion_archivos g
        WHERE ${scope.where} AND g.expires_at > NOW() ORDER BY g.id DESC`, scope.values);
      res.render('pages/georeferenciacion', {
        ...await listGeocodingLocations(pool, req.query),
        googleGeocodingQuota: await getGoogleGeocodingQuota(pool),
        files, configured: Boolean(getGeocodingKey()), localRoads: await getLocalRoadStatus(pool),
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch {
      res.status(500).send('No fue posible listar los archivos de Georeferenciación.');
    }
  });
  router.post('/importar', async (req, res, next) => {
    if (!getGeocodingKey()) return redirect(res, 'Falta configurar GOOGLE_GEOCODING_API_KEY en el servidor.');
    try {
      const quota = await getGoogleGeocodingQuota(pool);
      if (quota.isBlocked) return redirect(res, 'Se alcanzó el límite de 8000 consultas a Google Geocoding. Un administrador debe reiniciar el contador.');
    } catch (error) {
      return next(error);
    }
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
        (file_uuid, user_id, line_number, original_name, source_metadata, status, row_count, owner_group, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, DATE_ADD(NOW(), INTERVAL 2 DAY))`,
      [id, req.session.userId, line, req.file.originalname.slice(0, 255), JSON.stringify(metadata), input.rows.length - 1,
        fileGroupOf(req.session)]);
    } catch {
      return redirect(res, 'No fue posible guardar el archivo.');
    }
    jobs.set(id, { controller, userId: req.session.userId });
    queue = queue.then(async () => {
      try {
        const [files] = await pool.execute('SELECT file_uuid FROM georeferenciacion_archivos WHERE file_uuid = ? AND expires_at > NOW()', [id]);
        if (!files.length || controller.signal.aborted) return;
        const rows = await processGeocodingFile(input, {
          geocode: (latitude, longitude, options) => reverseGeocode(latitude, longitude, {
            ...options,
            beforeRequest: () => reserveGoogleGeocodingRequest(pool),
          }),
          crossStreets: createLocalCrossStreetLookup(pool),
          refreshStoredCrossStreets: true,
          findLocation: (latitude, longitude) => findGeocodingLocation(pool, latitude, longitude),
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
      const scope = visibleFiles(req.session);
      const [result] = await pool.execute(`DELETE g FROM georeferenciacion_archivos g WHERE g.file_uuid = ? AND ${scope.where}`,
        [req.params.id, ...scope.values]);
      if (result.affectedRows) jobs.get(req.params.id)?.controller.abort();
      return redirect(res, result.affectedRows ? 'Archivo eliminado.' : 'Archivo no encontrado.', result.affectedRows ? 'success' : 'error');
    } catch {
      return redirect(res, 'No fue posible eliminar el archivo.');
    }
  });
  for (const format of ['csv', 'xlsx']) {
    router.get(`/${format === 'csv' ? 'exportar' : 'exportar-xlsx'}/:id`, async (req, res) => {
      try {
        const scope = visibleFiles(req.session);
        const [files] = await pool.execute(`SELECT g.line_number, g.result_csv, g.source_metadata
          FROM georeferenciacion_archivos g WHERE g.file_uuid = ? AND ${scope.where}
          AND g.status = 'listo' AND g.expires_at > NOW()`, [req.params.id, ...scope.values]);
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
