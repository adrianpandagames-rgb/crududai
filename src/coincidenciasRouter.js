import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { processRutaCsv, processRutaXlsx } from './rutaService.js';
import { DEFAULT_METRES, DEFAULT_MINUTES, extractLineRecords, findCoincidences, lineFromFileName } from './coincidenciasService.js';

export const MAX_FILES = 20;

// A bounded whole number from a form field, or the default when it is left blank.
const numberField = (value, fallback, min, max) => {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const number = Number(text);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
};

export function createCoincidenciasRouter(pool) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 20 * 1024 * 1024, files: MAX_FILES, fields: MAX_FILES + 2, fieldSize: 4096,
  } }).array('archivos', MAX_FILES);
  router.use((req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    res.setHeader('Cache-Control', 'no-store');
    // OSM requires a Referer; cross-origin requests send only the site origin.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  router.get('/', (req, res) => res.render('pages/coincidencias', { maxFiles: MAX_FILES, DEFAULT_MINUTES, DEFAULT_METRES }));
  router.post('/buscar', (req, res, next) => upload(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE'
      ? 'Cada archivo puede pesar hasta 20 MB.'
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Sube hasta ${MAX_FILES} archivos a la vez.` : 'No fue posible recibir los archivos.' });
    next();
  }), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).json({ error: 'Selecciona al menos dos archivos para comparar.' });
    const invalid = files.find((file) => !['.csv', '.xlsx'].includes(path.extname(file.originalname).toLowerCase()));
    if (invalid) return res.status(400).json({ error: `${invalid.originalname} no es CSV ni Excel (.xlsx).` });
    const minutes = numberField(req.body.minutos, DEFAULT_MINUTES, 1, 1440);
    if (minutes === null) return res.status(400).json({ error: 'Los minutos deben ser un número entero entre 1 y 1440.' });
    const metres = numberField(req.body.metros, DEFAULT_METRES, 0, 50000);
    if (metres === null) return res.status(400).json({ error: 'La distancia debe ser un número entero de 0 a 50000 metros.' });
    const lines = [].concat(req.body.linea ?? []).map((value) => String(value).trim());
    const fileLines = files.map((file, index) => lines[index] || lineFromFileName(file.originalname));
    if (fileLines.some((line) => !line || line.length > 50)) {
      return res.status(400).json({ error: 'Cada línea debe tener de 1 a 50 caracteres.' });
    }
    if (new Set(fileLines).size < 2) {
      return res.status(400).json({ error: 'Todos los archivos tienen la misma línea; asigna al menos dos líneas distintas.' });
    }
    let locations;
    try {
      [locations] = await pool.query('SELECT idUbicacion, latitude, longitude, ubicacion, lugar FROM ubicaciones');
    } catch {
      return res.status(503).json({ error: 'No fue posible consultar las ubicaciones. Intenta nuevamente.' });
    }
    const records = [];
    const summaries = [];
    for (const [index, file] of files.entries()) {
      try {
        const rows = path.extname(file.originalname).toLowerCase() === '.xlsx'
          ? processRutaXlsx(file.buffer, locations) : processRutaCsv(file.buffer.toString('utf8'), locations);
        const result = extractLineRecords(rows, { file: file.originalname, line: fileLines[index] });
        records.push(...result.records);
        summaries.push({ name: file.originalname, line: fileLines[index], total: result.total, usable: result.records.length,
          withoutTime: result.withoutTime, withoutPosition: result.withoutPosition, hasDate: result.hasDate });
      } catch {
        return res.status(400).json({ error: `No fue posible procesar ${file.originalname}. Verifica el formato y el límite de 100000 filas.` });
      }
    }
    return res.json({ minutes, metres, files: summaries, ...findCoincidences(records, { minutes, metres }) });
  });
  return router;
}
