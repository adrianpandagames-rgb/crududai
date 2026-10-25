import express from 'express';
import crypto from 'node:crypto';
import { fileGroupOf, visibleFiles } from './fileGroups.js';
import { MAIGRET_MODES, SEARCH_TYPES, isValidUsername, normalizeUsername, runOsintSearch } from './maigretService.js';
import {
  emailAlias, isValidCountryCode, isValidEmail, isValidPhone, normalizeCountryCode, normalizeEmail, normalizePhone,
} from './osintTools.js';
import { createMaigretPdf } from './maigretPdf.js';

const MAX_QUEUED_SEARCHES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MaigretQueueFullError extends Error {
  constructor() {
    super('Hay demasiadas búsquedas en cola. Espera a que terminen algunas.');
  }
}

// One queue shared by the web tab and the Telegram bot, so only one Maigret process runs at a time.
export function createMaigretSearches(pool, { runSearch = runOsintSearch } = {}) {
  const jobs = new Map();
  let queue = Promise.resolve();
  let storage;

  const initialize = () => {
    if (!storage) storage = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS maigret_busquedas (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        search_uuid CHAR(36) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL,
        owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
        username VARCHAR(64) NOT NULL,
        mode VARCHAR(10) NOT NULL,
        recursive_search TINYINT(1) NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL,
        accounts_found INT UNSIGNED NOT NULL DEFAULT 0,
        results LONGTEXT NULL,
        report_html LONGTEXT NULL,
        error_message VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        INDEX maigret_group_created (owner_group, created_at)
      )`);
      // E-mail and phone searches share the table; older rows are username searches.
      const [typeColumn] = await pool.query("SHOW COLUMNS FROM maigret_busquedas LIKE 'search_type'");
      if (!typeColumn?.length) {
        await pool.query(`ALTER TABLE maigret_busquedas
          ADD COLUMN search_type VARCHAR(10) NOT NULL DEFAULT 'usuario' AFTER owner_group,
          MODIFY username VARCHAR(255) NOT NULL`);
      }
      // A search interrupted by a restart cannot resume, because Maigret keeps its progress in memory.
      await pool.query(`UPDATE maigret_busquedas SET status = 'error',
        error_message = 'El servidor se reinició durante la búsqueda. Vuelve a iniciarla.'
        WHERE status IN ('pendiente', 'procesando')`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };

  // Every entry point initializes first: the startup cleanup would otherwise mark searches queued
  // before it ran (from the name search tab or the bot) as interrupted by a restart.
  const find = async (session, id, columns) => {
    await initialize();
    if (!UUID_PATTERN.test(id)) return null;
    const scope = visibleFiles(session, 'm');
    const [rows] = await pool.execute(`SELECT ${columns} FROM maigret_busquedas m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.search_uuid = ? AND ${scope.where}`, [id, ...scope.values]);
    return rows[0] ?? null;
  };

  // `username` holds what was searched: a username, an e-mail or "+52 6621234567" for a phone.
  const enqueue = async (session, { type = 'usuario', username, mode, recursive, countryCode, phone, aliasSearchId = null }) => {
    await initialize();
    if (jobs.size >= MAX_QUEUED_SEARCHES) throw new MaigretQueueFullError();
    const id = crypto.randomUUID();
    await pool.execute(`INSERT INTO maigret_busquedas (search_uuid, user_id, owner_group, username, mode, recursive_search, status, search_type)
      VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)`, [id, session.userId, fileGroupOf(session), username, mode, recursive ? 1 : 0, type]);
    const controller = new AbortController();
    jobs.set(id, controller);
    queue = queue.then(async () => {
      if (controller.signal.aborted) return;
      try {
        await pool.execute("UPDATE maigret_busquedas SET status = 'procesando' WHERE search_uuid = ?", [id]);
        const result = await runSearch({ type, username, mode, recursive, countryCode, phone, signal: controller.signal });
        await pool.execute(`UPDATE maigret_busquedas SET status = 'listo', accounts_found = ?, results = ?, report_html = ?,
          error_message = ?, finished_at = NOW() WHERE search_uuid = ?`, [
          result.accounts.length,
          JSON.stringify({
            accounts: result.accounts, usernames: result.usernames, crossChecked: result.crossChecked ?? null,
            unverified: result.unverified ?? [], notes: result.notes ?? [], aliasSearchId,
          }),
          result.reportHtml,
          result.truncated ? 'La búsqueda superó el tiempo máximo; los resultados pueden estar incompletos.' : null,
          id,
        ]);
      } catch (error) {
        await pool.execute(`UPDATE maigret_busquedas SET status = 'error', error_message = ?, finished_at = NOW()
          WHERE search_uuid = ?`, [String(error.message || 'No fue posible completar la búsqueda.').slice(0, 500), id]).catch(() => {});
      } finally {
        jobs.delete(id);
      }
    });
    return id;
  };

  const remove = async (session, id) => {
    await initialize();
    if (!UUID_PATTERN.test(id)) return false;
    const scope = visibleFiles(session, 'm');
    const [result] = await pool.execute(`DELETE m FROM maigret_busquedas m WHERE m.search_uuid = ? AND ${scope.where}`,
      [id, ...scope.values]);
    if (result.affectedRows) jobs.get(id)?.abort();
    return result.affectedRows > 0;
  };

  return { initialize, find, enqueue, remove };
}

export function createMaigretRouter(pool, { runSearch, searches = createMaigretSearches(pool, { runSearch }) } = {}) {
  const router = express.Router();
  const redirect = (res, message, type = 'error') => res.redirect('/maigret?' + new URLSearchParams({ message, type }));

  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    try {
      await searches.initialize();
      next();
    } catch {
      res.status(503).send('No fue posible acceder a las búsquedas de Maigret.');
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const scope = visibleFiles(req.session, 'm');
      const [rows] = await pool.execute(`SELECT m.search_uuid AS id, m.username, m.mode, m.recursive_search AS recursiveSearch,
        m.search_type AS type, m.status, m.accounts_found AS accounts, m.error_message AS error, u.email AS requestedBy,
        DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS createdAt
        FROM maigret_busquedas m LEFT JOIN users u ON u.id = m.user_id
        WHERE ${scope.where} ORDER BY m.id DESC LIMIT 200`, scope.values);
      return res.render('pages/maigret', {
        searches: rows, modes: MAIGRET_MODES, types: SEARCH_TYPES,
        selectedType: Object.hasOwn(SEARCH_TYPES, req.query.tipo) ? req.query.tipo : 'usuario',
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/buscar', async (req, res, next) => {
    const type = Object.hasOwn(SEARCH_TYPES, req.body.tipo) ? req.body.tipo : 'usuario';
    const back = (message, kind = 'error') => res.redirect('/maigret?' + new URLSearchParams({ message, type: kind, tipo: type }));
    let request;
    if (type === 'correo') {
      const email = normalizeEmail(req.body.correo);
      if (!isValidEmail(email)) return back('Ingresa un correo válido, por ejemplo nombre@dominio.com.');
      request = { type, username: email, mode: 'correo', recursive: false };
    } else if (type === 'telefono') {
      const countryCode = normalizeCountryCode(req.body.lada);
      const phone = normalizePhone(req.body.telefono);
      if (!isValidCountryCode(countryCode)) return back('Ingresa la clave de país, por ejemplo 52 para México.');
      if (!isValidPhone(phone)) return back('Ingresa el teléfono sin la clave de país: de 6 a 14 dígitos.');
      request = { type, username: `+${countryCode} ${phone}`, mode: 'telefono', recursive: false, countryCode, phone };
    } else {
      const username = normalizeUsername(req.body.usuario);
      if (!isValidUsername(username)) {
        return back('Ingresa un nombre de usuario de hasta 64 caracteres: letras, números, punto, guion o guion bajo, sin espacios.');
      }
      request = { type, username, mode: Object.hasOwn(MAIGRET_MODES, req.body.modo) ? req.body.modo : 'rapida', recursive: req.body.recursivo === '1' };
    }
    // People often reuse the part before the @ as their username, so it can be searched too.
    const alias = type === 'correo' && req.body.alias === '1' ? emailAlias(request.username) : null;
    try {
      if (alias) request.aliasSearchId = await searches.enqueue(req.session, { username: alias, mode: 'rapida', recursive: true });
      await searches.enqueue(req.session, request);
    } catch (error) {
      if (error instanceof MaigretQueueFullError) return back(error.message);
      return next(error);
    }
    return back(`Búsqueda de "${request.username}" en cola${alias ? ` junto con el alias @${alias}` : ''}. Puede tardar varios minutos.`, 'success');
  });

  router.post('/eliminar/:id', async (req, res) => {
    try {
      const removed = await searches.remove(req.session, req.params.id);
      return redirect(res, removed ? 'Búsqueda eliminada.' : 'Búsqueda no encontrada.', removed ? 'success' : 'error');
    } catch {
      return redirect(res, 'No fue posible eliminar la búsqueda.');
    }
  });

  router.get('/:id/reporte', async (req, res, next) => {
    try {
      const search = await searches.find(req.session, req.params.id, 'm.username, m.report_html');
      if (!search?.report_html) return res.status(404).send('Reporte no encontrado o todavía no disponible.');
      res.type('text/html; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.query.ver === '1') {
        // The report repeats text from third-party profiles, so the view never runs scripts or shares the session.
        // Only the view is sandboxed: Chrome refuses downloads served from a sandboxed response.
        res.setHeader('Content-Security-Policy', "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src https: 'unsafe-inline'; img-src https: data:; font-src https:");
        res.setHeader('Content-Disposition', 'inline');
      } else {
        res.attachment(`Maigret-${search.username}.html`);
      }
      return res.send(search.report_html);
    } catch (error) {
      return next(error);
    }
  });

  const loadDetail = async (session, id) => {
    const search = await searches.find(session, id, `m.search_uuid AS id, m.username, m.mode, m.search_type AS type,
      m.recursive_search AS recursiveSearch, m.status, m.accounts_found AS accounts, m.results, m.error_message AS error,
      m.report_html IS NOT NULL AS hasReport, u.email AS requestedBy,
      DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS createdAt, DATE_FORMAT(m.finished_at, '%Y-%m-%d %H:%i') AS finishedAt`);
    if (!search) return null;
    search.type = Object.hasOwn(SEARCH_TYPES, search.type) ? search.type : 'usuario';
    const results = { accounts: [], usernames: [], ...(search.results ? JSON.parse(search.results) : {}) };
    const groups = results.usernames.map((name) => ({
      username: name,
      accounts: results.accounts.filter((account) => account.username === name),
    })).filter((group) => group.accounts.length > 0);
    const extras = {
      // null for searches made before Sherlock was added, so the page does not claim they were cross-checked.
      crossChecked: results.crossChecked ?? null,
      unverified: results.unverified ?? [],
      notes: results.notes ?? [],
      aliasSearchId: results.aliasSearchId ?? null,
    };
    return { search, groups, extras };
  };

  const fileLabel = (search) => ({ correo: 'Correo', telefono: 'Telefono' }[search.type] || 'Maigret');
  const fileName = (search) => `${fileLabel(search)}-${String(search.username).replace(/[^A-Za-z0-9@._-]+/g, '_')}`;

  router.get('/:id/pdf', async (req, res, next) => {
    try {
      const detail = await loadDetail(req.session, req.params.id);
      if (!detail || detail.search.status !== 'listo') return res.status(404).send('Reporte no encontrado o todavía no disponible.');
      const pdf = await createMaigretPdf({ ...detail, modeLabel: MAIGRET_MODES[detail.search.mode]?.label || detail.search.mode });
      res.type('application/pdf');
      res.attachment(`${fileName(detail.search)}.pdf`);
      return res.send(pdf);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const detail = await loadDetail(req.session, req.params.id);
      if (!detail) return res.status(404).send('Búsqueda no encontrada.');
      return res.render('pages/maigret-resultado', { ...detail, modes: MAIGRET_MODES, types: SEARCH_TYPES });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
