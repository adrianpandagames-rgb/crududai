import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { processRutaCsv, processRutaXlsx, createRutaCsv } from './rutaService.js';
import { extractPlanningPoints } from './planeacionService.js';

export function createPlaneacionRouter(pool) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 20 * 1024 * 1024, files: 1, fields: 1, fieldSize: 4096,
  } }).single('archivo');
  router.use((req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    if (req.session.isAdmin !== true) return res.status(403).json({ error: 'Disponible solo para administradores.' });
    res.setHeader('Cache-Control', 'no-store');
    // OSM requires a Referer; cross-origin requests send only the site origin.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  router.get('/', (req, res) => res.render('pages/planeacion-geografica'));
  router.post('/importar', (req, res, next) => upload(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE'
      ? 'El archivo supera el límite de 20 MB.' : 'No fue posible recibir el archivo.' });
    next();
  }), async (req, res) => {
    const line = String(req.body.linea || '').trim();
    if (!line || line.length > 50) return res.status(400).json({ error: 'Ingresa un número de línea de hasta 50 caracteres.' });
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
      return res.json({ name: req.file.originalname, line, headers: rows[0], rows: rows.slice(1),
        csv: '\uFEFF' + createRutaCsv(rows), ...extractPlanningPoints(rows) });
    } catch (error) {
      return res.status(400).json({ error: 'No fue posible procesar el archivo. Verifica el formato y el límite de 100000 filas.' });
    }
  });
  return router;
}
