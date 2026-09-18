import express from "express";
import multer from "multer";
import https from "https";
import http from "http";
import path from "path";
import crypto from "crypto";

import {
  agregarEstudiante,
  listarEstudiantes,
  listarImeis,
  listarUbicaciones,
  parseCoordinatesInput,
  obtenerOCrearObjetivo,
  obtenerOCrearObjetivoImei,
  agregarContacto,
  agregarImei,
  agregarUbicacion,
  contactoExisteExacto,
  imeiExisteExacto,
  contactoCoincidenciasParciales,
  imeiCoincidenciasParciales,
  imeiCoincidenciasPorObjetivo,
  buscarObjetivoEnObjetivoImei,
  buscarObjetivoEnObjetivo,
  verificarObjetivoConContactos,
  listarUbicacionesParaRuta,
  obtenerObjetivoPorId,
  actualizarObjetivo,
  obtenerImeiPorId,
  actualizarImei,
} from "./estudianteController.js";
import { maskApiKeyInUrl } from "./loggingUtils.js";
import { createRutaCsv, createRutaXlsx, getRutaXlsxMetadata, processRutaCsv, processRutaXlsx } from "./rutaService.js";
import pool from "./db.js";

const RUTA_MAX_FILE_SIZE = 20 * 1024 * 1024;
const uploadStorage = multer.memoryStorage();
const upload = multer({ storage: uploadStorage });
const rutaUploadParser = multer({ storage: uploadStorage, limits: { fileSize: RUTA_MAX_FILE_SIZE } });
const router = express.Router();
const MAX_REDIRECT_ITEMS = 20;
const PHONE_VALIDATION_API_URL = 'http://apilayer.net/api/validate';
const RUTA_PROCESSING_DELAY_MS = 10000;
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
  return true;
});

const requireRecordEditor = async (req, res, next) => {
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

const writeSearchAuditLog = (req, res, path, searchTerm) => {
  const normalizedTerm = String(searchTerm || '').trim();
  if (!normalizedTerm || !req.session) return;

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    req.app.locals.writeAuditLog?.({
      userId: req.session.userId,
      userEmail: req.session.email,
      action: 'SEARCH',
      requestPath: `${path}?search=${normalizedTerm.slice(0, 200)}`,
      statusCode: res.statusCode,
      ipAddress: req.ip,
    });
  });
};

const normalizePhoneNumber = (value) => String(value || '').replace(/\D/g, '');

const requestPhoneValidation = (url) => new Promise((resolve, reject) => {
  const request = http.get(url, { headers: { Accept: 'application/json' }, timeout: 10000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        resolve({ statusCode: response.statusCode, data: JSON.parse(body) });
      } catch {
        reject(new Error('La respuesta del servicio no tiene un formato válido.'));
      }
    });
  });

  request.on('timeout', () => request.destroy(new Error('La consulta telefónica tardó demasiado.')));
  request.on('error', reject);
});

const validatePhoneNumber = async (rawNumber) => {
  const digits = normalizePhoneNumber(rawNumber);
  if (digits.length < 7 || digits.length > 15) {
    const error = new Error('Ingresa un número telefónico de 7 a 15 dígitos, incluyendo el código de país.');
    error.status = 400;
    throw error;
  }

  const accessKey = process.env.PHONE_VALIDATION_ACCESS_KEY;
  if (!accessKey) {
    const error = new Error('La consulta telefónica no está configurada en el servidor.');
    error.status = 503;
    throw error;
  }

  const query = new URLSearchParams({
    access_key: accessKey,
    number: `+${digits}`,
    country_code: '',
    format: '1',
  });
  try {
    const { statusCode, data } = await requestPhoneValidation(`${PHONE_VALIDATION_API_URL}?${query.toString()}`);

    if (statusCode < 200 || statusCode >= 300 || !data) {
      const error = new Error('El servicio de validación telefónica no respondió correctamente.');
      error.status = 502;
      throw error;
    }

    return data;
  } catch (cause) {
    if (cause.status) throw cause;
    const error = new Error(cause.name === 'AbortError'
      ? 'La consulta telefónica tardó demasiado. Intenta nuevamente.'
      : 'No fue posible consultar el servicio de validación telefónica.');
    error.status = 502;
    throw error;
  }
};

const addJsonQueryParam = (url, key, value, maxItems = MAX_REDIRECT_ITEMS) => {
  if (!Array.isArray(value) || value.length === 0) {
    return url;
  }

  return `${url}&${key}=${encodeURIComponent(JSON.stringify(value.slice(0, maxItems)))}`;
};

const calculateLuhnCheckDigit = (base) => {
  let sum = 0;

  for (let i = 0; i < base.length; i++) {
    let digit = Number(base[i]);
    if (i % 2 === 1) {
      digit *= 2;
    }
    sum += Math.floor(digit / 10) + (digit % 10);
  }

  return String((10 - (sum % 10)) % 10);
};

const checkImeiAccountApi = (apiKey) => {
  const host = "dash.imei.info";
  const path = `/api/account/account/?API_KEY=${encodeURIComponent(apiKey)}`;

  return new Promise((resolve) => {
    const options = {
      hostname: host,
      path,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'nodejs-imei-client/1.0'
      },
      timeout: 10000,
    };

    console.log('Checking IMEI account API at', maskApiKeyInUrl(`https://${host}${path}`));

    const req = https.request(options, (response) => {
      const { statusCode } = response;
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        console.log(`IMEI account API response status: ${statusCode}`);
        resolve(statusCode === 200);
      });
    });

    req.on('error', (err) => {
      console.log('Error checking IMEI account API:', err && err.message);
      resolve(false);
    });

    req.on('timeout', () => {
      console.log('IMEI account API request timed out');
      req.destroy();
      resolve(false);
    });

    req.end();
  });
};

const getStoredImeiMetadata = async (imei) => {
  try {
    const [rows] = await pool.query(
      `SELECT brand_name, modelo
       FROM imei
       WHERE imei = ?
       ORDER BY idImei DESC
       LIMIT 1`,
      [imei],
    );

    const record = rows && rows[0];
    if (!record) {
      return null;
    }

    if (record.brand_name || record.modelo) {
      return {
        brand_name: record.brand_name || null,
        modelo: record.modelo || null,
        raw: null,
        available: true,
      };
    }

    return null;
  } catch (error) {
    console.log('Error reading stored IMEI metadata:', error && error.message ? error.message : error);
    return null;
  }
};

const fetchImeiMetadata = async (imei) => {
  const storedMetadata = await getStoredImeiMetadata(imei);
  if (storedMetadata) {
    console.log('Reusing stored IMEI metadata for', imei, 'instead of querying the API.');
    return storedMetadata;
  }

  const apiKey = process.env.IMEI_API_KEY;
  const serviceId = process.env.IMEI_SERVICE_ID || "0";
  const host = "dash.imei.info";

  if (!apiKey) {
    console.log('Skipping IMEI metadata lookup because IMEI_API_KEY is not configured.');
    return { brand_name: null, modelo: null, raw: null, available: false };
  }

  const path = `/api/check/${serviceId}/?API_KEY=${encodeURIComponent(apiKey)}&imei=${encodeURIComponent(imei)}`;

  const makeAttempt = (attemptsLeft) => {
    return new Promise((resolve) => {
      const options = {
        hostname: host,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'nodejs-imei-client/1.0'
        },
        timeout: 10000,
      };

      console.log('Fetching IMEI metadata from', maskApiKeyInUrl(`https://${host}${path}`), 'attemptsLeft=', attemptsLeft);

      const req = https.request(options, (response) => {
        const { statusCode } = response;
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          console.log(`IMEI metadata response status: ${statusCode}, length: ${data.length}`);
          console.log('IMEI metadata raw body (truncated 200 chars):', data && data.toString().slice(0, 200));
          try {
            const parsed = JSON.parse(data || '{}');
            console.log('IMEI metadata raw parsed:', parsed);
            const brandName = (parsed && typeof parsed.brand_name !== 'undefined') ? parsed.brand_name : (parsed?.result && typeof parsed.result.brand_name !== 'undefined' ? parsed.result.brand_name : null);
            const modelo = (parsed && typeof parsed.model !== 'undefined') ? parsed.model : (parsed?.result && typeof parsed.result.model !== 'undefined' ? parsed.result.model : null);
            resolve({ brand_name: brandName, modelo, raw: data });
          } catch (error) {
            console.log('Error parsing IMEI metadata JSON', error);
            resolve({ brand_name: null, modelo: null, raw: data });
          }
        });
      });

      req.on('error', (err) => {
        console.log('Error fetching IMEI metadata:', err && err.message);
        const isTimeoutLike = err && (err.code === 'ETIMEDOUT' || (err.message && err.message.toLowerCase().includes('timeout')));
        if (attemptsLeft > 0 && isTimeoutLike) {
          console.log('Retrying IMEI metadata fetch due to timeout/error, attempts left:', attemptsLeft - 1);
          setTimeout(() => makeAttempt(attemptsLeft - 1).then(resolve), 300);
        } else {
          resolve({ brand_name: null, modelo: null, raw: null });
        }
      });

      req.on('timeout', () => {
        console.log('IMEI metadata request timed out');
        req.destroy();
        if (attemptsLeft > 0) {
          console.log('Retrying IMEI metadata fetch after timeout, attempts left:', attemptsLeft - 1);
          setTimeout(() => makeAttempt(attemptsLeft - 1).then(resolve), 300);
        } else {
          resolve({ brand_name: null, modelo: null, raw: null });
        }
      });

      req.end();
    });
  };

  return checkImeiAccountApi(apiKey).then((accountApiOk) => {
    if (!accountApiOk) {
      console.log('Skipping IMEI metadata lookup because the account endpoint did not return HTTP 200');
      return { brand_name: null, modelo: null, raw: null, available: false };
    }

    // allow one retry (attemptsLeft = 1 => up to 2 attempts)
    return makeAttempt(1);
  });
};

const parseCsvRow = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
};

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check básico
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: La aplicación está funcionando
 */
router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Verificación de disponibilidad de la base de datos
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: La aplicación y la base de datos están listas
 *       503:
 *         description: La aplicación no está lista
 */
router.get('/health/ready', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    const ready = Array.isArray(rows) && rows.length > 0;

    if (!ready) {
      return res.status(503).json({
        status: 'not-ready',
        timestamp: new Date().toISOString(),
        database: 'unavailable',
      });
    }

    return res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      database: 'ok',
    });
  } catch (error) {
    return res.status(503).json({
      status: 'not-ready',
      timestamp: new Date().toISOString(),
      database: 'error',
      error: error.message || 'Database check failed',
    });
  }
});

router.get('/api/localidades', async (req, res, next) => {
  const state = String(req.query.estado || '').trim();
  try {
    if (!state) {
      const [rows] = await pool.query('SELECT DISTINCT estado FROM localidades_mexico ORDER BY estado');
      return res.json({ estados: rows.map((row) => row.estado) });
    }

    const [rows] = await pool.query(
      'SELECT localidad FROM localidades_mexico WHERE estado = ? ORDER BY localidad',
      [state],
    );
    return res.json({ estado: state, localidades: rows.map((row) => row.localidad) });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/ubicaciones/heatmap', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT latitude, longitude, COUNT(*) AS weight
      FROM ubicaciones
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      GROUP BY latitude, longitude
      ORDER BY weight DESC, latitude, longitude
    `);

    return res.json({
      points: rows.map((row) => ({
        lat: Number(row.latitude),
        lng: Number(row.longitude),
        weight: Number(row.weight) || 1,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/lineas/editar/:id', requireRecordEditor, async (req, res) => {
  const idObjetivo = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(idObjetivo) || idObjetivo < 1) return res.status(400).send('Línea inválida.');
  const objetivo = await obtenerObjetivoPorId(idObjetivo);
  if (!objetivo) return res.status(404).send('Línea no encontrada.');
  return res.render('pages/editar-linea', { objetivo, error: null });
});

router.post('/lineas/editar/:id', requireRecordEditor, async (req, res) => {
  const idObjetivo = Number.parseInt(req.params.id, 10);
  const objetivo = {
    idObjetivo,
    numObjetivo: String(req.body.numObjetivo || '').trim(),
    nuc: String(req.body.nuc || '').trim(),
    tipo: String(req.body.tipo || '').trim(),
    ano: String(req.body.ano || '').trim(),
  };
  if (!Number.isSafeInteger(idObjetivo) || idObjetivo < 1 || !objetivo.numObjetivo || !objetivo.nuc || !objetivo.tipo || !/^\d{4}$/.test(objetivo.ano)) {
    return res.status(400).render('pages/editar-linea', { objetivo, error: 'Completa todos los campos con valores válidos.' });
  }
  try {
    const updated = await actualizarObjetivo(idObjetivo, objetivo);
    if (!updated) return res.status(404).send('Línea no encontrada.');
    return res.redirect('/Crud?message=' + encodeURIComponent('Línea actualizada correctamente.') + '&type=success');
  } catch (error) {
    return res.status(500).render('pages/editar-linea', { objetivo, error: 'No fue posible actualizar la línea.' });
  }
});

router.get('/imei/editar/:id', requireRecordEditor, async (req, res) => {
  const idImei = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(idImei) || idImei < 1) return res.status(400).send('IMEI inválido.');
  const imei = await obtenerImeiPorId(idImei);
  if (!imei) return res.status(404).send('IMEI no encontrado.');
  return res.render('pages/editar-imei', { imei, error: null });
});

router.post('/imei/editar/:id', requireRecordEditor, async (req, res) => {
  const idImei = Number.parseInt(req.params.id, 10);
  const imei = {
    idImei,
    imei: String(req.body.imei || '').replace(/\D/g, ''),
    numObjetivo: String(req.body.numObjetivo || '').trim(),
    nuc: String(req.body.nuc || '').trim(),
    tipo: String(req.body.tipo || '').trim(),
    ano: String(req.body.ano || '').trim(),
    brandName: String(req.body.brandName || '').trim(),
    modelo: String(req.body.modelo || '').trim(),
  };
  const validImei = /^\d{15}$/.test(imei.imei) && imei.imei[14] === String(calculateLuhnCheckDigit(imei.imei.slice(0, 14)));
  if (!Number.isSafeInteger(idImei) || idImei < 1 || !validImei || !imei.numObjetivo || !imei.nuc || !imei.tipo || !/^\d{4}$/.test(imei.ano)) {
    return res.status(400).render('pages/editar-imei', { imei, error: 'Completa todos los campos con valores válidos. El IMEI debe tener 15 dígitos válidos.' });
  }
  try {
    const updated = await actualizarImei(idImei, imei);
    if (!updated) return res.status(404).send('IMEI no encontrado.');
    return res.redirect('/imei?message=' + encodeURIComponent('IMEI actualizado correctamente.') + '&type=success');
  } catch (error) {
    return res.status(500).render('pages/editar-imei', { imei, error: 'No fue posible actualizar el IMEI.' });
  }
});

router.get("/Crud", async (req, res) => {
  try {
    const searchTerm = req.query.numObjetivo || req.query.search || "";
    writeSearchAuditLog(req, res, '/Crud', searchTerm);
    const page = Number.isInteger(parseInt(req.query.page, 10)) ? Math.max(parseInt(req.query.page, 10), 1) : 1;
    const pageSize = Number.isInteger(parseInt(req.query.pageSize, 10)) ? Math.max(parseInt(req.query.pageSize, 10), 1) : 10;

    const { rows: objetivos, total } = await listarEstudiantes(searchTerm, page, pageSize);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const startIndex = (page - 1) * pageSize + 1;

    let objectiveImeiMatches = [];
    if (searchTerm) {
      const nucObjetivo = req.query.nucObjetivo || "";
      const ano = req.query.ano || "";
      objectiveImeiMatches = await buscarObjetivoEnObjetivoImei(searchTerm, nucObjetivo, ano);
    }

    if (req.query.fragment === '1') {
      return res.render('partials/contactos-results', {
        objetivos,
        searchTerm,
        currentPage: page,
        totalPages,
        startIndex,
        pageSize,
      });
    }

    res.render("pages/estudiantes", {
      objetivos,
      searchTerm,
      objectiveImeiMatches,
      message: req.query.message || null,
      messageType: req.query.type || null,
      currentPage: page,
      totalPages,
      startIndex,
      pageSize,
    });
  } catch (error) {
    const { status, message } = error;
    res.status(status || 500).json({ error: message });
  }
});

router.get('/telefono', (req, res) => {
  res.render('pages/telefono');
});

/**
 * @openapi
 * /api/telefono/validar:
 *   post:
 *     summary: Validar un número telefónico
 *     tags: [Telefono]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - number
 *             properties:
 *               number:
 *                 type: string
 *                 example: '+521234567890'
 *     responses:
 *       200:
 *         description: Resultado de validación
 *       400:
 *         description: Número inválido
 *       500:
 *         description: Error del servidor
 */
router.post('/api/telefono/validar', async (req, res) => {
  try {
    const result = await validatePhoneNumber(req.body?.number);
    return res.json({ result });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'No fue posible validar el número.' });
  }
});

router.get("/imei", async (req, res) => {
  try {
    const searchTerm = req.query.search || "";
    writeSearchAuditLog(req, res, '/imei', searchTerm);
    const page = Number.isInteger(parseInt(req.query.page, 10)) ? Math.max(parseInt(req.query.page, 10), 1) : 1;
    const pageSize = Number.isInteger(parseInt(req.query.pageSize, 10)) ? Math.max(parseInt(req.query.pageSize, 10), 1) : 10;

    const { rows: imeis, total } = await listarImeis(searchTerm, page, pageSize);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const startIndex = (page - 1) * pageSize + 1;

    if (req.query.fragment === '1') {
      return res.render('partials/imei-results', {
        imeis,
        searchTerm,
        currentPage: page,
        totalPages,
        startIndex,
        pageSize,
      });
    }

    res.render("pages/imei", {
      imeis,
      searchTerm,
      message: req.query.message || null,
      messageType: req.query.type || null,
      currentPage: page,
      totalPages,
      startIndex,
      pageSize,
    });
  } catch (error) {
    const { status, message } = error;
    res.status(status || 500).json({ error: message });
  }
});

export { fetchImeiMetadata };

router.get("/ubicaciones", async (req, res) => {
  try {
    const searchTerm = req.query.search || "";
    writeSearchAuditLog(req, res, '/ubicaciones', searchTerm);
    const page = Number.isInteger(parseInt(req.query.page, 10)) ? Math.max(parseInt(req.query.page, 10), 1) : 1;
    const pageSize = Number.isInteger(parseInt(req.query.pageSize, 10)) ? Math.max(parseInt(req.query.pageSize, 10), 1) : 10;

    const { rows: ubicaciones, total } = await listarUbicaciones(searchTerm, page, pageSize);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const startIndex = (page - 1) * pageSize + 1;

    if (req.query.fragment === '1') {
      return res.render('partials/ubicaciones-results', {
        ubicaciones,
        searchTerm,
        currentPage: page,
        totalPages,
        startIndex,
        pageSize,
      });
    }

    res.render("pages/ubicaciones", {
      ubicaciones,
      searchTerm,
      message: req.query.message || null,
      messageType: req.query.type || null,
      currentPage: page,
      totalPages,
      startIndex,
      pageSize,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ,
    });
  } catch (error) {
    const { status, message } = error;
    res.status(status || 500).json({ error: message });
  }
});

router.post('/ubicaciones/register', async (req, res) => {
  try {
    const { coordinates, ubicacion, estado, lugar } = req.body;
    const rawCoordinates = String(coordinates || '').trim();
    const parsedCoordinates = parseCoordinatesInput(rawCoordinates);

    if (!parsedCoordinates || !ubicacion || !estado || !lugar) {
      return res.redirect('/ubicaciones?message=' + encodeURIComponent('Coordenadas, ubicación, estado y ciudad son requeridos. Usa latitud y longitud numéricas o DMS.') + '&type=error');
    }

    const { latitude, longitude } = parsedCoordinates;
    const cityAndState = `${lugar.trim()}, ${estado.trim()}`;

    await agregarUbicacion({ latitude, longitude, ubicacion: ubicacion.trim(), lugar: cityAndState });
    return res.redirect('/ubicaciones?message=' + encodeURIComponent('Ubicación registrada con éxito.') + '&type=success');
  } catch (error) {
    console.error(error);
    const message = error && error.status === 409
      ? 'La coordenada ya se encuentra registrada.'
      : 'Error al registrar la ubicación.';
    return res.redirect('/ubicaciones?message=' + encodeURIComponent(message) + '&type=error');
  }
});

router.get('/ruta', (req, res) => {
  Promise.resolve()
    .then(() => cleanExpiredRutaFiles())
    .then(async () => {
      const [files] = await pool.query(
        `SELECT file_uuid AS id, line_number AS lineNumber, original_name AS name,
                status, row_count AS \`rows\`, error_message AS error
         FROM ruta_archivos
          ORDER BY created_at DESC, id DESC`,
      );
      res.render('pages/ruta', {
        files,
        message: req.query.message || null,
        messageType: req.query.type || null,
        highlightId: req.query.highlight || null,
      });
    })
    .catch((error) => res.status(500).json({ error: error.message }));
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
       (file_uuid, line_number, original_name, source_metadata, source_file, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pendiente', DATE_ADD(NOW(), INTERVAL 2 DAY))`,
    [id, lineNumber, req.file.originalname, sourceMetadata ? JSON.stringify(sourceMetadata) : null, req.file.buffer],
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
    const [result] = await pool.execute(
      'DELETE FROM ruta_archivos WHERE file_uuid = ?',
      [req.params.id],
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
    const [files] = await pool.execute(
      `SELECT line_number, status, result_csv, source_metadata
       FROM ruta_archivos
       WHERE file_uuid = ? AND expires_at > NOW()
       LIMIT 1`,
      [req.params.id],
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
    const [files] = await pool.execute(
      `SELECT line_number, status, result_csv, source_metadata
       FROM ruta_archivos
       WHERE file_uuid = ? AND expires_at > NOW()
       LIMIT 1`,
      [req.params.id],
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

router.get("/No", async (req, res) => {
    res.redirect("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1");

});



router.post('/imei/register', async (req, res) => {
  try {
    const { imeiBase, nucObjetivo, curso_dc, ano } = req.body;
    const normalizedImeiBase = String(imeiBase || '').replace(/\D/g, '').slice(0, 14);
    const imeiCompleto = normalizedImeiBase.length === 14
      ? normalizedImeiBase + calculateLuhnCheckDigit(normalizedImeiBase)
      : '';
    const rawObjetivos = req.body.numObjetivo || req.body['numObjetivo[]'];
    const objetivos = Array.isArray(rawObjetivos) ? rawObjetivos : rawObjetivos ? [rawObjetivos] : [];

    if (!/^\d{15}$/.test(imeiCompleto) || objetivos.length === 0 || !nucObjetivo || !curso_dc || !ano) {
      return res.redirect('/imei?message=' + encodeURIComponent('IMEI de 14 dígitos, al menos un Objetivo, NUC, Año y Tipo son requeridos.') + '&type=error');
    }

    const exactDuplicates = [];
    const partialMatches = [];
    let inserted = 0;
    let imeiMetadataUnavailable = false;

    for (const numObjetivo of objetivos) {
      if (!numObjetivo || numObjetivo.toString().trim() === '') {
        continue;
      }

      const { idObjetivo, tipo: objetivoTipo } = await obtenerOCrearObjetivoImei(numObjetivo, nucObjetivo, curso_dc, ano);
      const alreadyExists = await imeiExisteExacto(imeiCompleto, numObjetivo, nucObjetivo, objetivoTipo, ano);

      if (alreadyExists) {
        exactDuplicates.push({ imei: imeiCompleto, numObjetivo, nuc: nucObjetivo, ano, tipo: objetivoTipo });
        continue;
      }

      const objectiveDuplicates = await imeiCoincidenciasPorObjetivo(numObjetivo, nucObjetivo, ano, imeiCompleto);
      objectiveDuplicates.forEach((match) => {
        partialMatches.push({
          imei: match.imei,
          numObjetivo: match.numObjetivo,
          nuc: match.nuc,
          ano: match.ano,
          tipo: match.tipo,
          issue: match.issue,
        });
      });

      const objetivoEnObjetivo = await buscarObjetivoEnObjetivo(numObjetivo, nucObjetivo, ano);
      if (objetivoEnObjetivo.length > 0) {
        objetivoEnObjetivo.forEach((match) => {
          partialMatches.push({
            imei: imeiCompleto,
            numObjetivo: match.numObjetivo,
            nuc: match.nuc,
            ano: match.ano,
            tipo: match.tipo,
            issue: 'Objetivo también existe en tabla Objetivo',
          });
        });
      }

      const metadata = await fetchImeiMetadata(imeiCompleto);
      if (metadata?.available === false) {
        imeiMetadataUnavailable = true;
      }
      console.log('IMEI metadata for', imeiCompleto, metadata);
      await agregarImei(imeiCompleto, idObjetivo, metadata);
      inserted += 1;

      const partials = await imeiCoincidenciasParciales(imeiCompleto, numObjetivo, nucObjetivo, objetivoTipo, ano);
      partials.forEach((match) => {
        partialMatches.push({
          imei: imeiCompleto,
          numObjetivo: match.numObjetivo,
          nuc: match.nuc,
          ano: match.ano,
          tipo: match.tipo,
          issue: match.issue,
        });
      });
    }

    let message;
    let messageType = 'success';

    if (inserted === 0) {
      message = 'No se registró ningún IMEI porque todos los objetivos ya existen exactamente con ese IMEI.';
      messageType = 'error';
    } else if (partialMatches.length > 0) {
      message = `IMEI registrado correctamente en ${inserted} objetivo(s). Existe una coincidencia parcial con otros objetivos/NUC/año.`;
    } else {
      message = `IMEI registrado con éxito, se han registrado ${inserted} objetivo(s).`;
    }

    let redirectUrl = '/imei?message=' + encodeURIComponent(message) + '&type=' + encodeURIComponent(messageType);
    if (imeiMetadataUnavailable) {
      redirectUrl += '&toastMessage=' + encodeURIComponent('El sistema de IMEI no está disponible. El IMEI se registrará sin estos datos.');
    }
    redirectUrl = addJsonQueryParam(redirectUrl, 'exactDuplicates', exactDuplicates);
    redirectUrl = addJsonQueryParam(redirectUrl, 'partials', partialMatches);

    return res.redirect(redirectUrl);
  } catch (error) {
    console.error(error);
    return res.redirect('/imei?message=' + encodeURIComponent('Registro de IMEI falló.') + '&type=error');
  }
});

router.post('/Crud/import-csv', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.redirect('/Crud?message=' + encodeURIComponent('No file uploaded.') + '&type=error');
    }

    const { numObjetivo, nucObjetivo, curso_dc, ano } = req.body;
    if (!numObjetivo || !nucObjetivo || !curso_dc || !ano) {
      return res.redirect('/Crud?message=' + encodeURIComponent('Objetivo, NUC, Año y Tipo son requeridos.') + '&type=error');
    }

    const csv = req.file.buffer.toString('utf8');
    const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length === 0) {
      return res.redirect('/Crud?message=' + encodeURIComponent('CSV no contiene datos válidos.') + '&type=error');
    }

    let headerIndex = -1;
    let headers = [];
    for (let i = 0; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]).map((header) => header.trim().toLowerCase());
      if (row.some((value) => value === 'contactos')) {
        headerIndex = i;
        headers = row;
        break;
      }
    }

    if (headerIndex === -1) {
      return res.redirect('/Crud?message=' + encodeURIComponent('CSV header debe incluir la columna: contactos.') + '&type=error');
    }

    const contactColumnIndex = headers.findIndex((value) => value === 'contactos');
    if (contactColumnIndex === -1) {
      return res.redirect('/Crud?message=' + encodeURIComponent('CSV header debe incluir la columna: contactos.') + '&type=error');
    }

    const contactosCSV = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const values = parseCsvRow(lines[i]);
      const contactoValue = values[contactColumnIndex] ? values[contactColumnIndex].trim() : '';
      if (contactoValue !== '' && /^\d+$/.test(contactoValue)) {
        contactosCSV.push(contactoValue);
      }
    }

    if (contactosCSV.length === 0) {
      return res.json({ status: 'error', message: 'CSV no contiene contactos válidos.' });
    }

    const forceFollowup = req.body.forceFollowup === 'true';
    const verificacion = await verificarObjetivoConContactos(numObjetivo, nucObjetivo, ano, contactosCSV);

    const normalizedTipo = String(curso_dc || '').trim().toLowerCase();
    const isSolucion = normalizedTipo === 'solución' || normalizedTipo === 'solucion';
    const mismosObjetivos = verificacion.objetivos || [];
    const tieneSolucionExistente = mismosObjetivos.some((obj) => {
      const tipoObj = String(obj.tipo || '').trim().toLowerCase();
      return tipoObj === 'solución' || tipoObj === 'solucion';
    });

    const validateOnly = req.query.validateOnly === 'true' || req.body.validateOnly === 'true';
    if (verificacion.conMismos && !forceFollowup) {
      return res.json({
        status: 'duplicado_detectado',
        message: 'Ya existe un objetivo idéntico con los mismos contactos. No se importará de nuevo.',
        duplicado: {
          numObjetivo,
          nuc: nucObjetivo,
          tipo: verificacion.conMismos.tipo,
          tipoExistente: verificacion.conMismos.tipo,
          contactosCount: verificacion.conMismos.contactos.length,
        }
      });
    }

    if (isSolucion && tieneSolucionExistente && !forceFollowup) {
      return res.json({
        status: 'confirm_followup',
        duplicado: {
          numObjetivo,
          nuc: nucObjetivo,
          tipoExistente: 'Solución',
          contactosCount: contactosCSV.length,
          message: 'Ya existe un objetivo Solución con ese número. ¿Desea guardarlo como Seguimiento?'
        }
      });
    }

    if (validateOnly) {
      return res.json({ status: 'ready' });
    }

    // Si está forzando seguimiento, usar el tipo "Seguimiento" en lugar del que envió
    let cursoToUse = curso_dc;
    if (forceFollowup && (verificacion.conMismos || isSolucion)) {
      cursoToUse = 'Seguimiento';
    }

    // Obtener o crear objetivo con el tipo correcto
    const { idObjetivo, tipo: objetivoTipo } = await obtenerOCrearObjetivo(numObjetivo, nucObjetivo, cursoToUse, ano);

    let insertCount = 0;
    let exactDuplicateCount = 0;
    const exactDuplicates = [];
    const partialMatches = [];

    for (let i = headerIndex + 1; i < lines.length; i++) {
      const values = parseCsvRow(lines[i]);
      const contactoValue = values[contactColumnIndex] ? values[contactColumnIndex].trim() : '';
      if (contactoValue !== '') {
        if (/^\d+$/.test(contactoValue)) {
          const alreadyExists = await contactoExisteExacto(contactoValue, numObjetivo, nucObjetivo, objetivoTipo, ano);
          if (!alreadyExists) {
            await agregarContacto(contactoValue, idObjetivo);
            insertCount += 1;
            const partials = await contactoCoincidenciasParciales(contactoValue, numObjetivo, nucObjetivo, objetivoTipo, ano);
            partials.forEach((match) => {
              partialMatches.push({
                contacto: contactoValue,
                numObjetivo: match.numObjetivo,
                nuc: match.nuc,
                ano: match.ano,
                tipo: match.tipo,
              });
            });
          } else {
            exactDuplicateCount += 1;
            exactDuplicates.push({
              contacto: contactoValue,
              numObjetivo,
              nuc: nucObjetivo,
              ano,
              tipo: objetivoTipo,
            });
          }
        }
      }
    }

    let message = `CSV imported successfully. ${insertCount} contacts added.`;
    if (exactDuplicateCount > 0) {
      message += ` ${exactDuplicateCount} duplicate contacts skipped.`;
    }
    if (partialMatches.length > 0) {
      message += ` ${partialMatches.length} inserted contacts have partial matches with other objectives/NUC/año.`;
    }

    const redirectUrl = '/Crud?message=' + encodeURIComponent(message) + '&type=success';

    return res.json({
      status: 'success',
      message: message,
      redirect: redirectUrl,
      exactDuplicates,
      partialMatches
    });
  } catch (error) {
    console.error(error);
    return res.json({
      status: 'error',
      message: 'CSV import failed.',
      error: error.message
    });
  }
});

// Registrar un nuevo estudiante
router.post("/estudiantes", async (req, res) => {
  const { nombre_alumno, email_alumno, curso_alumno } = req.body;

  try {
    await agregarEstudiante({ nombre_alumno, email_alumno, curso_alumno });
    res.redirect("/Crud");
  } catch (error) {
    const { status, message } = error;
    res.status(status || 500).json({ error: message });
  }
});

export default router;
