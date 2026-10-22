import express from 'express';
import crypto from 'node:crypto';
import { fileGroupOf, visibleFiles } from './fileGroups.js';
import { MAIGRET_MODES, isValidUsername, normalizeUsername, runMaigret } from './maigretService.js';

const MAX_QUEUED_SEARCHES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMaigretRouter(pool, { runSearch = runMaigret } = {}) {
  const router = express.Router();
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
      // A search interrupted by a restart cannot resume, because Maigret keeps its progress in memory.
      await pool.query(`UPDATE maigret_busquedas SET status = 'error',
        error_message = 'El servidor se reinició durante la búsqueda. Vuelve a iniciarla.'
        WHERE status IN ('pendiente', 'procesando')`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };
  const redirect = (res, message, type = 'error') => res.redirect('/maigret?' + new URLSearchParams({ message, type }));
  const findVisible = async (session, id, columns) => {
    if (!UUID_PATTERN.test(id)) return null;
    const scope = visibleFiles(session, 'm');
    const [rows] = await pool.execute(`SELECT ${columns} FROM maigret_busquedas m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.search_uuid = ? AND ${scope.where}`, [id, ...scope.values]);
    return rows[0] ?? null;
  };

  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    try {
      await initialize();
      next();
    } catch {
      res.status(503).send('No fue posible acceder a las búsquedas de Maigret.');
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const scope = visibleFiles(req.session, 'm');
      const [searches] = await pool.execute(`SELECT m.search_uuid AS id, m.username, m.mode, m.recursive_search AS recursiveSearch,
        m.status, m.accounts_found AS accounts, m.error_message AS error, u.email AS requestedBy,
        DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS createdAt
        FROM maigret_busquedas m LEFT JOIN users u ON u.id = m.user_id
        WHERE ${scope.where} ORDER BY m.id DESC LIMIT 200`, scope.values);
      return res.render('pages/maigret', {
        searches, modes: MAIGRET_MODES,
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/buscar', async (req, res, next) => {
    const username = normalizeUsername(req.body.usuario);
    const mode = Object.hasOwn(MAIGRET_MODES, req.body.modo) ? req.body.modo : 'rapida';
    const recursive = req.body.recursivo === '1';
    if (!isValidUsername(username)) {
      return redirect(res, 'Ingresa un nombre de usuario de hasta 64 caracteres: letras, números, punto, guion o guion bajo, sin espacios.');
    }
    if (jobs.size >= MAX_QUEUED_SEARCHES) return redirect(res, 'Hay demasiadas búsquedas en cola. Espera a que terminen algunas.');

    const id = crypto.randomUUID();
    try {
      await pool.execute(`INSERT INTO maigret_busquedas (search_uuid, user_id, owner_group, username, mode, recursive_search, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`, [id, req.session.userId, fileGroupOf(req.session), username, mode, recursive ? 1 : 0]);
    } catch (error) {
      return next(error);
    }
    const controller = new AbortController();
    jobs.set(id, controller);
    queue = queue.then(async () => {
      if (controller.signal.aborted) return;
      try {
        await pool.execute("UPDATE maigret_busquedas SET status = 'procesando' WHERE search_uuid = ?", [id]);
        const result = await runSearch({ username, mode, recursive, signal: controller.signal });
        await pool.execute(`UPDATE maigret_busquedas SET status = 'listo', accounts_found = ?, results = ?, report_html = ?,
          error_message = ?, finished_at = NOW() WHERE search_uuid = ?`, [
          result.accounts.length,
          JSON.stringify({ accounts: result.accounts, usernames: result.usernames }),
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
    return redirect(res, `Búsqueda de "${username}" en cola. Puede tardar varios minutos.`, 'success');
  });

  router.post('/eliminar/:id', async (req, res) => {
    try {
      if (!UUID_PATTERN.test(req.params.id)) return redirect(res, 'Búsqueda no encontrada.');
      const scope = visibleFiles(req.session, 'm');
      const [result] = await pool.execute(`DELETE m FROM maigret_busquedas m WHERE m.search_uuid = ? AND ${scope.where}`,
        [req.params.id, ...scope.values]);
      if (result.affectedRows) jobs.get(req.params.id)?.abort();
      return redirect(res, result.affectedRows ? 'Búsqueda eliminada.' : 'Búsqueda no encontrada.', result.affectedRows ? 'success' : 'error');
    } catch {
      return redirect(res, 'No fue posible eliminar la búsqueda.');
    }
  });

  router.get('/:id/reporte', async (req, res, next) => {
    try {
      const search = await findVisible(req.session, req.params.id, 'm.username, m.report_html');
      if (!search?.report_html) return res.status(404).send('Reporte no encontrado o todavía no disponible.');
      res.type('text/html; charset=utf-8');
      res.attachment(`Maigret-${search.username}.html`);
      return res.send(search.report_html);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const search = await findVisible(req.session, req.params.id, `m.search_uuid AS id, m.username, m.mode,
        m.recursive_search AS recursiveSearch, m.status, m.accounts_found AS accounts, m.results, m.error_message AS error,
        m.report_html IS NOT NULL AS hasReport, u.email AS requestedBy,
        DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS createdAt, DATE_FORMAT(m.finished_at, '%Y-%m-%d %H:%i') AS finishedAt`);
      if (!search) return res.status(404).send('Búsqueda no encontrada.');
      const results = search.results ? JSON.parse(search.results) : { accounts: [], usernames: [] };
      const groups = results.usernames.map((name) => ({
        username: name,
        accounts: results.accounts.filter((account) => account.username === name),
      })).filter((group) => group.accounts.length > 0);
      return res.render('pages/maigret-resultado', { search, groups, modes: MAIGRET_MODES });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
