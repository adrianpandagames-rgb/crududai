import express from 'express';
import crypto from 'node:crypto';
import { parseSearchCoordinates } from './coordinateSearch.js';
import { generateAntennaMap, validateAntennaMap } from './antenaMapService.js';
import { createCoverageGeocoder } from './telegramGeocodingService.js';
import { buildAuditDetails } from './auditDetails.js';
import { telegramIdHash } from './telegramIdCrypto.js';
import { MaigretQueueFullError } from './maigretRouter.js';
import { isValidUsername, normalizeUsername } from './maigretService.js';

const PAGE_SIZE = 5;
const MAX_BOT_MAIGRET_ACCOUNTS = 100;

export function buildTelegramQuery(command, term, page) {
  if (typeof term !== 'string' || !term.trim() || term.length > 120 || !Number.isInteger(page) || page < 1 || page > 100) {
    throw new Error('Consulta o página inválida.');
  }
  term = term.trim();
  let sql;
  let params;
  if (command === 'linea') {
    if (!/^\+?\d{7,15}$/.test(term)) throw new Error('Número de línea inválido.');
    sql = `SELECT o.idObjetivo, o.numObjetivo, o.nuc, o.tipo, o.ano, o.delito,
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

export function createTelegramApiRouter(pool, config = process.env, mapRenderer = generateAntennaMap, geocodingLookup = createCoverageGeocoder(pool), maigretSearches = null) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const secret = config.TELEGRAM_API_TOKEN || '';
    if (secret.length < 32) return res.status(503).json({ error: 'API del bot no configurada.' });
    const provided = req.get('Authorization') || '';
    const expected = `Bearer ${secret}`;
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (!crypto.timingSafeEqual(digest(provided), digest(expected))) return res.status(401).json({ error: 'Credencial inválida.' });
    const userId = req.get('X-Telegram-User-Id');
    if (!userId || !/^[1-9]\d{0,19}$/.test(userId)) return res.status(403).json({ error: 'Usuario no autorizado.' });
    let userHash;
    try { userHash = telegramIdHash(userId, config); }
    catch { return res.status(503).json({ error: 'API del bot no configurada.' }); }
    pool.execute('SELECT id, role, is_admin FROM users WHERE telegram_id_hash = ? AND is_active = 1 LIMIT 1', [userHash])
      .then(([rows]) => {
        if (rows.length !== 1) return res.status(403).json({ error: 'Usuario no autorizado.' });
        // Same role rules as a web session, so bot searches respect the UECS/general file groups.
        const isAdmin = Number(rows[0].is_admin) === 1 || rows[0].role === 'admin';
        req.botUser = { userId: rows[0].id, isAdmin, role: isAdmin ? 'admin' : (rows[0].role || 'usuario') };
        // Only attribute activity after validating both the bot credential and linked active user.
        req.auditTelegram = true;
        const requestPath = `${req.baseUrl}${req.path}`;
        const command = req.path.replace(/^\//, '');
        res.on('finish', () => {
          req.app.locals.writeAuditLog?.({
            userId: null,
            userEmail: `Telegram ID ${userId}`,
            action: 'SEARCH',
            requestPath,
            statusCode: res.statusCode,
            ipAddress: req.ip,
            details: {
              ...(buildAuditDetails(req) || {}),
              origen: 'Telegram',
              telegram_user_id: userId,
              comando: command,
              metodo: req.method,
            },
          });
        });
        return next();
      })
      .catch(() => res.status(503).json({ error: 'No fue posible validar el usuario.' }));
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
  const requireMaigret = async (req, res, next) => {
    if (!maigretSearches) return res.status(503).json({ error: 'Maigret no está disponible.' });
    try {
      await maigretSearches.initialize();
      return next();
    } catch {
      return res.status(503).json({ error: 'No fue posible acceder a las búsquedas de Maigret.' });
    }
  };
  // The bot offers the quick and normal depths; a full search takes too long for a chat.
  router.post('/maigret', express.json({ limit: '2kb' }), requireMaigret, async (req, res) => {
    const username = normalizeUsername(req.body?.usuario);
    const mode = req.body?.modo === 'normal' ? 'normal' : 'rapida';
    if (!isValidUsername(username)) return res.status(400).json({ error: 'Nombre de usuario inválido.' });
    try {
      const id = await maigretSearches.enqueue(req.botUser, { username, mode, recursive: true });
      return res.status(202).json({ id, username, mode });
    } catch (error) {
      if (error instanceof MaigretQueueFullError) return res.status(429).json({ error: error.message });
      return res.status(503).json({ error: 'No fue posible iniciar la búsqueda.' });
    }
  });
  router.get('/maigret/:id', requireMaigret, async (req, res) => {
    try {
      const search = await maigretSearches.find(req.botUser, req.params.id,
        'm.search_uuid AS id, m.username, m.mode, m.status, m.accounts_found AS total, m.results, m.error_message AS error, m.report_html IS NOT NULL AS hasReport');
      if (!search) return res.status(404).json({ error: 'Búsqueda no encontrada.' });
      const results = search.results ? JSON.parse(search.results) : { accounts: [] };
      const baseUrl = (config.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      return res.json({
        id: search.id,
        username: search.username,
        mode: search.mode,
        status: search.status,
        total: Number(search.total),
        error: search.error,
        has_report: Boolean(search.hasReport),
        web_url: baseUrl ? `${baseUrl}/maigret/${search.id}` : null,
        accounts: results.accounts.slice(0, MAX_BOT_MAIGRET_ACCOUNTS)
          .map(({ username, site, url, similar }) => ({ username, site, url, similar })),
      });
    } catch {
      return res.status(503).json({ error: 'No fue posible consultar la búsqueda.' });
    }
  });
  router.get('/maigret/:id/reporte', requireMaigret, async (req, res) => {
    try {
      const search = await maigretSearches.find(req.botUser, req.params.id, 'm.report_html');
      if (!search?.report_html) return res.status(404).json({ error: 'Reporte no disponible.' });
      return res.type('text/html; charset=utf-8').send(search.report_html);
    } catch {
      return res.status(503).json({ error: 'No fue posible obtener el reporte.' });
    }
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
