import express from 'express';
import crypto from 'node:crypto';
import { parseSearchCoordinates } from './coordinateSearch.js';
import { generateAntennaMap, validateAntennaMap } from './antenaMapService.js';
import { createCoverageGeocoder } from './telegramGeocodingService.js';

const PAGE_SIZE = 5;

export function buildTelegramQuery(command, term, page) {
  if (typeof term !== 'string' || !term.trim() || term.length > 120 || !Number.isInteger(page) || page < 1 || page > 100) {
    throw new Error('Consulta o página inválida.');
  }
  term = term.trim();
  let sql;
  let params;
  if (command === 'linea') {
    if (!/^\+?\d{7,15}$/.test(term)) throw new Error('Número de línea inválido.');
    sql = `SELECT o.idObjetivo, o.numObjetivo, o.nuc, o.tipo, o.ano,
      ? AS numeroConsultado, (o.numObjetivo = ?) AS esObjetivo,
      EXISTS (SELECT 1 FROM contactos c WHERE c.idObjetivo = o.idObjetivo AND c.contacto = ?) AS esContacto
      FROM objetivo o
      WHERE o.numObjetivo = ? OR EXISTS (SELECT 1 FROM contactos c WHERE c.idObjetivo = o.idObjetivo AND c.contacto = ?)
      ORDER BY o.idObjetivo DESC`;
    params = [term, term, term, term, term];
  } else if (command === 'imei') {
    if (!/^\d{14,16}$/.test(term)) throw new Error('IMEI inválido.');
    sql = `SELECT i.idImei, i.imei, i.brand_name, i.modelo, o.numObjetivo, o.nuc, o.tipo, o.ano
      FROM imei i INNER JOIN objetivoImei o ON o.idObjetivo = i.idObjetivo
      WHERE i.imei = ? ORDER BY i.idImei DESC LIMIT ? OFFSET ?`;
    params = [term];
  } else if (command === 'antena') {
    sql = 'SELECT idUbicacion, latitude, longitude, ubicacion, lugar FROM ubicaciones WHERE ';
    const coordinate = parseSearchCoordinates(term);
    if (coordinate) {
      const { latitude: lat, longitude: lng } = coordinate;
      sql += 'ABS(CAST(latitude AS DECIMAL(10,6)) - ?) < 0.000001 AND ABS(CAST(longitude AS DECIMAL(10,6)) - ?) < 0.000001';
      params = [lat, lng];
    } else {
      sql += "LOCATE(?, CONCAT_WS('|', latitude, longitude, ubicacion, lugar)) > 0";
      params = [term];
    }
    sql += ' ORDER BY idUbicacion DESC LIMIT ? OFFSET ?';
  } else {
    throw new Error('Comando desconocido.');
  }
  return { sql, params: command === 'linea' ? params : [...params, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE] };
}

export function createTelegramApiRouter(pool, config = process.env, mapRenderer = generateAntennaMap, geocodingLookup = createCoverageGeocoder(pool)) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const secret = config.TELEGRAM_API_TOKEN || '';
    if (secret.length < 32) return res.status(503).json({ error: 'API del bot no configurada.' });
    const provided = req.get('Authorization') || '';
    const expected = `Bearer ${secret}`;
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (!crypto.timingSafeEqual(digest(provided), digest(expected))) return res.status(401).json({ error: 'Credencial inválida.' });
    const ids = (config.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(id => /^[1-9]\d*$/.test(id));
    const userId = req.get('X-Telegram-User-Id');
    if (!userId || !ids.includes(userId)) return res.status(403).json({ error: 'Usuario no autorizado.' });
    next();
  });
  let rendering = false;
  router.post('/cobertura/ubicacion', express.json({ limit: '4kb' }), async (req, res) => {
    let parameters;
    try { parameters = validateAntennaMap(req.body || {}); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      return res.json(await geocodingLookup(parameters.lat, parameters.lng));
    } catch {
      return res.status(503).json({ error: 'No fue posible consultar o guardar la ubicación de Geocoding. Revisa la configuración de Google Geocoding y la base de datos.' });
    }
  });
  router.get('/cobertura', async (req, res) => {
    let parameters;
    try { parameters = validateAntennaMap(req.query); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    if (rendering) return res.status(429).json({ error: 'Hay un mapa en proceso. Intenta nuevamente en unos segundos.' });
    rendering = true;
    try {
      const image = await mapRenderer(parameters);
      return res.type('png').send(image);
    } catch {
      return res.status(503).json({ error: 'No fue posible cargar el mapa de fondo. Intenta nuevamente más tarde.' });
    } finally { rendering = false; }
  });
  for (const command of ['linea', 'imei', 'antena']) {
    router.get(`/${command}`, async (req, res) => {
      let query;
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      try {
        query = buildTelegramQuery(command, req.query.q, page);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      try {
        const [rows] = await pool.query(query.sql, query.params);
        if (command === 'linea') return res.json({ rows, page: 1, has_more: false });
        return res.json({ rows: rows.slice(0, PAGE_SIZE), page, has_more: page < 100 && rows.length > PAGE_SIZE });
      } catch (error) {
        console.error('Consulta API Telegram fallida:', command, error.code || 'DATABASE_ERROR');
        return res.status(503).json({ error: 'No fue posible consultar los registros.' });
      }
    });
  }
  return router;
}
