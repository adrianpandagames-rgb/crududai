import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { processRutaCsv, processRutaXlsx, createRutaCsv } from './rutaService.js';
import { extractPlanningPoints } from './planeacionService.js';
import { OPERATORS, estimateRange, loadSites } from './alcanceService.js';

export function createPlaneacionRouter(pool, { sites = loadSites } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 20 * 1024 * 1024, files: 1, fields: 1, fieldSize: 4096,
  } }).single('archivo');
  router.use((req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    res.setHeader('Cache-Control', 'no-store');
    // OSM requires a Referer; cross-origin requests send only the site origin.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  router.get('/', (req, res) => res.render('pages/planeacion-geografica'));
  // Estimated reach per antenna from the density of the operator's sites (OpenCelliD dump kept on the server).
  // Only coordinates and azimuths arrive here, and nothing is sent to any outside service.
  router.post('/alcance', async (req, res) => {
    const operator = Object.hasOwn(OPERATORS, req.body?.operador) ? OPERATORS[req.body.operador] : null;
    const antennas = req.body?.antenas;
    if (!operator) return res.status(400).json({ error: 'Elige un operador válido.' });
    if (!Array.isArray(antennas) || !antennas.length || antennas.length > 5000) {
      return res.status(400).json({ error: 'Envía de 1 a 5000 antenas.' });
    }
    const valid = antennas.every((a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lng) && Math.abs(a.lat) <= 90
      && Math.abs(a.lng) <= 180 && (a.azimuth === null || (Number.isFinite(a.azimuth) && a.azimuth >= 0 && a.azimuth <= 360)));
    if (!valid) return res.status(400).json({ error: 'Cada antena necesita latitud, longitud y azimut (o null).' });
    let index;
    try {
      index = await sites();
    } catch {
      return res.status(503).json({ error: 'La base de sitios (OpenCelliD) no está disponible en este servidor.' });
    }
    // Every location of the file is a site of the line's operator, so each antenna also measures against the others.
    const fileSites = [...new Map(antennas.map((a) => [`${a.lat},${a.lng}`, { lat: a.lat, lng: a.lng }])).values()];
    return res.json({ operador: operator.label, alcances: antennas.map((a) => estimateRange(index, a, operator.mnc, undefined, fileSites)) });
  });
  router.post('/importar', (req, res, next) => upload(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE'
      ? 'El archivo supera el límite de 20 MB.' : 'No fue posible recibir el archivo.' });
    next();
  }), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo CSV o Excel (.xlsx).' });
    const extension = path.extname(req.file.originalname).toLowerCase();
    if (!['.csv', '.xlsx'].includes(extension)) return res.status(400).json({ error: 'El archivo debe ser CSV o Excel (.xlsx).' });
    let locations;
    try {
      [locations] = await pool.query('SELECT idUbicacion, latitude, longitude, ubicacion, lugar FROM ubicaciones');
    } catch {
      return res.status(503).json({ error: 'No fue posible consultar las ubicaciones. Intenta nuevamente.' });
    }
    try {
      const rows = extension === '.xlsx' ? processRutaXlsx(req.file.buffer, locations)
        : processRutaCsv(req.file.buffer.toString('utf8'), locations);
      if (rows.length < 2) return res.status(400).json({ error: 'El archivo no contiene registros.' });
      return res.json({ name: req.file.originalname, headers: rows[0], rows: rows.slice(1),
        csv: '\uFEFF' + createRutaCsv(rows), ...extractPlanningPoints(rows) });
    } catch (error) {
      return res.status(400).json({ error: 'No fue posible procesar el archivo. Verifica el formato y el límite de 100000 filas.' });
    }
  });
  return router;
}
