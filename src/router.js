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
} from "./estudianteController.js";
import { maskApiKeyInUrl } from "./loggingUtils.js";
import { createRutaCsv, processRutaCsv, processRutaXlsx } from "./rutaService.js";
import pool from "./db.js";

const RUTA_MAX_FILE_SIZE = 20 * 1024 * 1024;
const uploadStorage = multer.memoryStorage();
const upload = multer({ storage: uploadStorage });
const rutaUploadParser = multer({ storage: uploadStorage, limits: { fileSize: RUTA_MAX_FILE_SIZE } });
const router = express.Router();
const MAX_REDIRECT_ITEMS = 20;
const PHONE_VALIDATION_API_URL = 'http://apilayer.net/api/validate';
const rutaStorageReady = pool.query(`
  CREATE TABLE IF NOT EXISTS ruta_archivos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    file_uuid CHAR(36) NOT NULL UNIQUE,
    line_number VARCHAR(50) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL,
    result_csv LONGTEXT NULL,
    row_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_message VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    INDEX ruta_archivos_expires_at_index (expires_at)
  )
`).then(() => true);

const cleanExpiredRutaFiles = async () => {
  await rutaStorageReady;
  await pool.query('DELETE FROM ruta_archivos WHERE expires_at <= NOW()');
};

const processRutaFile = async (job, buffer, extension) => {
  try {
    const locations = await listarUbicacionesParaRuta();
    const rows = extension === '.xlsx'
      ? processRutaXlsx(buffer, locations)
      : processRutaCsv(buffer.toString('utf8'), locations);
    const resultCsv = '\uFEFF' + createRutaCsv(rows);
    await pool.execute(
      `UPDATE ruta_archivos
       SET status = 'listo', result_csv = ?, row_count = ?, error_message = NULL
       WHERE file_uuid = ? AND expires_at > NOW()`,
      [resultCsv, Math.max(rows.length - 1, 0), job.id],
    );
  } catch (error) {
    await pool.execute(
      `UPDATE ruta_archivos
       SET status = 'error', error_message = ?
       WHERE file_uuid = ? AND expires_at > NOW()`,
      [error.message || 'No fue posible procesar el archivo.', job.id],
    ).catch((updateError) => console.error('Unable to update Ruta file:', updateError.message));
  }
};

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

const fetchImeiMetadata = (imei) => {
  const apiKey = process.env.IMEI_API_KEY;
  const serviceId = process.env.IMEI_SERVICE_ID || "0";
  const host = "dash.imei.info";

  if (!apiKey) {
    console.log('Skipping IMEI metadata lookup because IMEI_API_KEY is not configured.');
    return Promise.resolve({ brand_name: null, modelo: null, raw: null, available: false });
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
    const { coordinates, ubicacion, lugar } = req.body;
    const rawCoordinates = String(coordinates || '').trim();
    const parsedCoordinates = parseCoordinatesInput(rawCoordinates);

    if (!parsedCoordinates || !ubicacion || !lugar) {
      return res.redirect('/ubicaciones?message=' + encodeURIComponent('Coordenadas, ubicación y lugar son requeridos. Usa latitud y longitud numéricas o DMS.') + '&type=error');
    }

    const { latitude, longitude } = parsedCoordinates;

    await agregarUbicacion({ latitude, longitude, ubicacion: ubicacion.trim(), lugar: lugar.trim() });
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
  await cleanExpiredRutaFiles();
  await pool.execute(
    `INSERT INTO ruta_archivos (file_uuid, line_number, original_name, status, expires_at)
     VALUES (?, ?, ?, 'pendiente', DATE_ADD(NOW(), INTERVAL 2 DAY))`,
    [id, lineNumber, req.file.originalname],
  );
  const job = { id };
  setImmediate(() => processRutaFile(job, req.file.buffer, extension));

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
      `SELECT line_number, status, result_csv
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
