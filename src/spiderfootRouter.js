import express from 'express';
import crypto from 'node:crypto';
import { fileGroupOf, visibleFiles } from './fileGroups.js';
import {
  EVENT_CATEGORIES, SPIDERFOOT_MODES, SPIDERFOOT_TYPES, STOP_REASON, describeEventType, parseTarget, runSpiderfoot,
} from './spiderfootService.js';

const MAX_QUEUED_SEARCHES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SpiderfootQueueFullError extends Error {
  constructor() {
    super('Hay demasiadas búsquedas en cola. Espera a que terminen algunas.');
  }
}

// Its own queue, apart from Maigret's: a SpiderFoot search can take hours and must not hold up the others.
export function createSpiderfootSearches(pool, { runSearch = runSpiderfoot } = {}) {
  const jobs = new Map();
  let queue = Promise.resolve();
  let storage;

  const initialize = () => {
    if (!storage) storage = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS spiderfoot_busquedas (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        search_uuid CHAR(36) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL,
        owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
        search_type VARCHAR(10) NOT NULL,
        target VARCHAR(255) NOT NULL,
        target_shown VARCHAR(255) NOT NULL,
        target_type VARCHAR(30) NOT NULL,
        mode VARCHAR(10) NOT NULL,
        status VARCHAR(20) NOT NULL,
        events_found INT UNSIGNED NOT NULL DEFAULT 0,
        results LONGTEXT NULL,
        error_message VARCHAR(500) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME NULL,
        INDEX spiderfoot_group_created (owner_group, created_at)
      )`);
      // A search interrupted by a restart cannot resume, because its scan lived in a temporary folder.
      await pool.query(`UPDATE spiderfoot_busquedas SET status = 'error',
        error_message = 'El servidor se reinició durante la búsqueda. Vuelve a iniciarla.'
        WHERE status IN ('pendiente', 'procesando')`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };

  const find = async (session, id, columns) => {
    await initialize();
    if (!UUID_PATTERN.test(id)) return null;
    const scope = visibleFiles(session, 's');
    const [rows] = await pool.execute(`SELECT ${columns} FROM spiderfoot_busquedas s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.search_uuid = ? AND ${scope.where}`, [id, ...scope.values]);
    return rows[0] ?? null;
  };

  const enqueue = async (session, { type, target, targetType, shown, mode }) => {
    await initialize();
    if (jobs.size >= MAX_QUEUED_SEARCHES) throw new SpiderfootQueueFullError();
    const id = crypto.randomUUID();
    await pool.execute(`INSERT INTO spiderfoot_busquedas (search_uuid, user_id, owner_group, search_type, target, target_shown, target_type, mode, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`, [id, session.userId, fileGroupOf(session), type, target, shown, targetType, mode]);
    const controller = new AbortController();
    jobs.set(id, controller);
    queue = queue.then(async () => {
      try {
        if (controller.signal.aborted) {
          await pool.execute(`UPDATE spiderfoot_busquedas SET status = 'error', error_message = 'La búsqueda se canceló antes de iniciar.',
            finished_at = NOW() WHERE search_uuid = ?`, [id]);
          return;
        }
        await pool.execute("UPDATE spiderfoot_busquedas SET status = 'procesando' WHERE search_uuid = ?", [id]);
        const result = await runSearch({ target, targetType, mode, signal: controller.signal });
        await pool.execute(`UPDATE spiderfoot_busquedas SET status = 'listo', events_found = ?, results = ?, error_message = NULL,
          finished_at = NOW() WHERE search_uuid = ?`, [
          result.events.length,
          JSON.stringify({ events: result.events, notes: result.notes ?? [], partial: Boolean(result.partial) }),
          id,
        ]);
      } catch (error) {
        await pool.execute(`UPDATE spiderfoot_busquedas SET status = 'error', error_message = ?, finished_at = NOW()
          WHERE search_uuid = ?`, [String(error.message || 'No fue posible completar la búsqueda.').slice(0, 500), id]).catch(() => {});
      } finally {
        jobs.delete(id);
      }
    });
    return id;
  };

  // Stopping keeps what the scan found so far; deleting throws it away.
  const stop = async (session, id) => {
    const search = await find(session, id, 's.search_uuid');
    const job = search && jobs.get(id);
    if (!job) return false;
    job.abort(STOP_REASON);
    return true;
  };

  const remove = async (session, id) => {
    await initialize();
    if (!UUID_PATTERN.test(id)) return false;
    const scope = visibleFiles(session, 's');
    const [result] = await pool.execute(`DELETE s FROM spiderfoot_busquedas s WHERE s.search_uuid = ? AND ${scope.where}`,
      [id, ...scope.values]);
    if (result.affectedRows) jobs.get(id)?.abort();
    return result.affectedRows > 0;
  };

  return { initialize, find, enqueue, stop, remove };
}

// Events grouped by category, then by type, in the order the page shows them.
export function groupEvents(events) {
  const categories = Object.keys(EVENT_CATEGORIES).map((key) => ({ key, label: EVENT_CATEGORIES[key], types: new Map(), total: 0 }));
  const byKey = new Map(categories.map((category) => [category.key, category]));
  for (const event of events) {
    const { label, category } = describeEventType(event.type);
    const group = byKey.get(category);
    if (!group.types.has(event.type)) group.types.set(event.type, { type: event.type, label, events: [] });
    group.types.get(event.type).events.push(event);
    group.total++;
  }
  return categories.filter((category) => category.total > 0).map((category) => ({
    ...category,
    types: [...category.types.values()].sort((a, b) => b.events.length - a.events.length || a.label.localeCompare(b.label)),
  }));
}

const csvCell = (value) => {
  const text = String(value ?? '');
  // A leading =, +, - or @ would run as a formula in Excel.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// Shared by the web download and the file the Telegram bot sends.
export function spiderfootCsv(events) {
  const lines = events.map((event) => {
    const { label, category } = describeEventType(event.type);
    return [EVENT_CATEGORIES[category], label, event.data, event.module, event.source].map(csvCell).join(',');
  });
  return `﻿${['Categoría,Tipo,Dato,Módulo,Origen', ...lines].join('\r\n')}\r\n`;
}

export const spiderfootFileName = (target) => `SpiderFoot-${String(target).replace(/[^A-Za-z0-9@._-]+/g, '_')}`;

export function createSpiderfootRouter(pool, { runSearch, searches = createSpiderfootSearches(pool, { runSearch }) } = {}) {
  const router = express.Router();
  const back = (res, message, type = 'error', tipo) => res.redirect('/spiderfoot?' + new URLSearchParams({ message, type, ...(tipo ? { tipo } : {}) }));

  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    try {
      await searches.initialize();
      next();
    } catch {
      res.status(503).send('No fue posible acceder a las búsquedas de SpiderFoot.');
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const scope = visibleFiles(req.session, 's');
      const [rows] = await pool.execute(`SELECT s.search_uuid AS id, s.search_type AS type, s.target_shown AS target, s.mode,
        s.status, s.events_found AS events, s.error_message AS error, u.email AS requestedBy,
        DATE_FORMAT(s.created_at, '%Y-%m-%d %H:%i') AS createdAt
        FROM spiderfoot_busquedas s LEFT JOIN users u ON u.id = s.user_id
        WHERE ${scope.where} ORDER BY s.id DESC LIMIT 200`, scope.values);
      return res.render('pages/spiderfoot', {
        searches: rows, modes: SPIDERFOOT_MODES, types: SPIDERFOOT_TYPES,
        selectedType: Object.hasOwn(SPIDERFOOT_TYPES, req.query.tipo) ? req.query.tipo : 'dominio',
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/buscar', async (req, res, next) => {
    const type = Object.hasOwn(SPIDERFOOT_TYPES, req.body.tipo) ? req.body.tipo : 'dominio';
    const parsed = parseTarget(type, req.body);
    if (parsed.error) return back(res, parsed.error, 'error', type);
    const mode = Object.hasOwn(SPIDERFOOT_MODES, req.body.modo) ? req.body.modo : 'rapida';
    const shown = parsed.shown ?? parsed.target;
    try {
      await searches.enqueue(req.session, { type, target: parsed.target, targetType: parsed.targetType, shown, mode });
    } catch (error) {
      if (error instanceof SpiderfootQueueFullError) return back(res, error.message, 'error', type);
      return next(error);
    }
    return back(res, `Búsqueda de "${shown}" en cola. ${SPIDERFOOT_MODES[mode].label}.`, 'success', type);
  });

  router.post('/detener/:id', async (req, res) => {
    try {
      const stopped = await searches.stop(req.session, req.params.id);
      const message = stopped ? 'Deteniendo la búsqueda; en unos segundos se guardará lo encontrado.' : 'La búsqueda ya no está en proceso.';
      return res.redirect(`/spiderfoot/${encodeURIComponent(req.params.id)}?` + new URLSearchParams({ message, type: stopped ? 'success' : 'error' }));
    } catch {
      return back(res, 'No fue posible detener la búsqueda.');
    }
  });

  router.post('/eliminar/:id', async (req, res) => {
    try {
      const removed = await searches.remove(req.session, req.params.id);
      return back(res, removed ? 'Búsqueda eliminada.' : 'Búsqueda no encontrada.', removed ? 'success' : 'error');
    } catch {
      return back(res, 'No fue posible eliminar la búsqueda.');
    }
  });

  const loadDetail = async (session, id) => {
    const search = await searches.find(session, id, `s.search_uuid AS id, s.search_type AS type, s.target_shown AS target, s.mode,
      s.status, s.events_found AS events, s.results, s.error_message AS error, u.email AS requestedBy,
      DATE_FORMAT(s.created_at, '%Y-%m-%d %H:%i') AS createdAt, DATE_FORMAT(s.finished_at, '%Y-%m-%d %H:%i') AS finishedAt`);
    if (!search) return null;
    const results = { events: [], notes: [], partial: false, ...(search.results ? JSON.parse(search.results) : {}) };
    delete search.results;
    return { search, results };
  };

  router.get('/:id/csv', async (req, res, next) => {
    try {
      const detail = await loadDetail(req.session, req.params.id);
      if (!detail || detail.search.status !== 'listo') return res.status(404).send('Resultados no encontrados o todavía no disponibles.');
      res.type('text/csv; charset=utf-8');
      res.attachment(`${spiderfootFileName(detail.search.target)}.csv`);
      return res.send(spiderfootCsv(detail.results.events));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const detail = await loadDetail(req.session, req.params.id);
      if (!detail) return res.status(404).send('Búsqueda no encontrada.');
      return res.render('pages/spiderfoot-resultado', {
        ...detail, categories: groupEvents(detail.results.events), modes: SPIDERFOOT_MODES, types: SPIDERFOOT_TYPES,
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
