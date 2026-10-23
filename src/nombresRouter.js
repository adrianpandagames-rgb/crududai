import express from 'express';
import { MaigretQueueFullError } from './maigretRouter.js';
import {
  LIST_SOURCES, buildNameIndex, isIdentifierQuery, normalizeName, parseOfac, parseSat69b,
  preparedSearches, searchNameIndex, usernameVariants,
} from './nameSearchService.js';

const REFRESH_AFTER_HOURS = 24;
const RETRY_AFTER_ERROR_MINUTES = 60;
const DOWNLOAD_TIMEOUT_MS = 120000;
const INSERT_CHUNK = 1000;

const download = async (fetchImpl, url, encoding) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'User-Agent': 'CRUDUDAI/1.0' } });
  if (!response.ok) throw new Error(`La descarga respondió ${response.status}.`);
  return new TextDecoder(encoding).decode(await response.arrayBuffer());
};

const loaders = {
  ofac: async (fetchImpl) => parseOfac(
    await download(fetchImpl, LIST_SOURCES.ofac.urls.sdn, 'utf-8'),
    await download(fetchImpl, LIST_SOURCES.ofac.urls.alt, 'utf-8'),
  ),
  sat69b: async (fetchImpl) => parseSat69b(await download(fetchImpl, LIST_SOURCES.sat69b.urls.list, 'latin1')),
};

// Downloads the official lists into MySQL and keeps a search index in memory.
export function createNameLists(pool, { fetchImpl = fetch } = {}) {
  let storage;
  let index = null;
  const refreshing = new Map();

  const initialize = () => {
    if (!storage) storage = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS nombre_listas (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source VARCHAR(20) NOT NULL,
        source_id VARCHAR(64) NOT NULL,
        name VARCHAR(600) NOT NULL,
        details TEXT NULL,
        INDEX nombre_listas_source (source)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS nombre_listas_fuentes (
        source VARCHAR(20) NOT NULL PRIMARY KEY,
        updated_at DATETIME NULL,
        entries INT UNSIGNED NOT NULL DEFAULT 0,
        attempted_at DATETIME NULL,
        error_message VARCHAR(500) NULL
      )`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };

  const getIndex = async () => {
    if (!index) {
      const [rows] = await pool.query('SELECT source, source_id AS sourceId, name, details FROM nombre_listas');
      index = buildNameIndex(rows.map((row) => ({ ...row, details: JSON.parse(row.details || '{}') })));
    }
    return index;
  };

  const refresh = (source) => {
    if (refreshing.has(source)) return refreshing.get(source);
    const task = (async () => {
      await pool.query(`INSERT INTO nombre_listas_fuentes (source, attempted_at) VALUES (?, NOW())
        ON DUPLICATE KEY UPDATE attempted_at = NOW()`, [source]);
      try {
        const entries = await loaders[source](fetchImpl);
        // A list that suddenly comes back nearly empty is a broken download, not a real update.
        if (entries.length < 100) throw new Error(`La lista descargada solo trae ${entries.length} registros.`);
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query('DELETE FROM nombre_listas WHERE source = ?', [source]);
          for (let start = 0; start < entries.length; start += INSERT_CHUNK) {
            const rows = entries.slice(start, start + INSERT_CHUNK)
              .map((entry) => [source, entry.sourceId.slice(0, 64), entry.name.slice(0, 600), JSON.stringify(entry.details)]);
            await connection.query('INSERT INTO nombre_listas (source, source_id, name, details) VALUES ?', [rows]);
          }
          await connection.query(`UPDATE nombre_listas_fuentes SET updated_at = NOW(), entries = ?, error_message = NULL
            WHERE source = ?`, [entries.length, source]);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
        index = null;
      } catch (error) {
        await pool.query('UPDATE nombre_listas_fuentes SET error_message = ? WHERE source = ?',
          [String(error.message || 'No fue posible descargar la lista.').slice(0, 500), source]).catch(() => {});
        throw error;
      } finally {
        refreshing.delete(source);
      }
    })();
    refreshing.set(source, task);
    return task;
  };

  const status = async () => {
    const [rows] = await pool.query(`SELECT source, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') AS updatedAt, entries,
      error_message AS error,
      updated_at IS NULL OR updated_at < NOW() - INTERVAL ${REFRESH_AFTER_HOURS} HOUR AS stale,
      attempted_at IS NOT NULL AND attempted_at > NOW() - INTERVAL ${RETRY_AFTER_ERROR_MINUTES} MINUTE AS recentAttempt
      FROM nombre_listas_fuentes`);
    const bySource = new Map(rows.map((row) => [row.source, row]));
    return Object.entries(LIST_SOURCES).map(([source, { label }]) => {
      const row = bySource.get(source);
      return {
        source, label,
        updatedAt: row?.updatedAt ?? null,
        entries: Number(row?.entries ?? 0),
        error: row?.error ?? null,
        stale: !row || Number(row.stale) === 1,
        recentAttempt: Number(row?.recentAttempt ?? 0) === 1,
        refreshing: refreshing.has(source),
      };
    });
  };

  // Stale lists refresh in the background; a failed download waits an hour before retrying.
  const refreshStale = async () => {
    for (const list of await status()) {
      if (list.stale && !list.refreshing && !(list.error && list.recentAttempt)) {
        refresh(list.source).catch((error) => console.error(`No se pudo actualizar la lista ${list.source}:`, error.message));
      }
    }
  };

  return { initialize, getIndex, refresh, status, refreshStale };
}

export function createNombresRouter(pool, { lists = createNameLists(pool), maigretSearches = null } = {}) {
  const router = express.Router();
  const redirect = (res, message, type = 'error', query = {}) => res.redirect('/nombres?' + new URLSearchParams({ ...query, message, type }));

  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    try {
      await lists.initialize();
      next();
    } catch {
      res.status(503).send('No fue posible acceder a RastroX.');
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      await lists.refreshStale();
      const name = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ') : '';
      const city = typeof req.query.ciudad === 'string' ? req.query.ciudad.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
      let search = null;
      let error = '';
      if (name) {
        const identifier = isIdentifierQuery(name);
        if (name.length > 120) error = 'El nombre debe tener hasta 120 caracteres.';
        else if (!identifier && normalizeName(name).split(' ').filter(Boolean).length < 2) error = 'Escribe al menos nombre y apellido, o un RFC o CURP completo.';
        else {
          const results = searchNameIndex(await lists.getIndex(), name);
          search = {
            name, city, identifier, results,
            links: identifier ? [] : preparedSearches(name, city),
            variants: identifier ? [] : usernameVariants(name),
          };
        }
      }
      return res.render('pages/nombres', {
        search, error, name, city,
        listStatus: await lists.status(),
        sources: LIST_SOURCES,
        canRefresh: req.session.isAdmin === true,
        maigretAvailable: Boolean(maigretSearches),
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/actualizar', (req, res) => {
    if (req.session.isAdmin !== true) return res.status(403).send('Solo un administrador puede actualizar las listas.');
    for (const source of Object.keys(LIST_SOURCES)) {
      lists.refresh(source).catch((error) => console.error(`No se pudo actualizar la lista ${source}:`, error.message));
    }
    return redirect(res, 'Actualizando las listas oficiales. Tarda alrededor de un minuto.', 'success');
  });

  router.post('/maigret', async (req, res, next) => {
    const name = String(req.body.nombre || '').trim();
    const variants = usernameVariants(name);
    if (!maigretSearches || variants.length === 0) return redirect(res, 'No se pudieron generar usuarios a partir de ese nombre.', 'error', { q: name });
    let queued = 0;
    try {
      for (const username of variants) {
        await maigretSearches.enqueue(req.session, { username, mode: 'rapida', recursive: false });
        queued++;
      }
    } catch (error) {
      if (!(error instanceof MaigretQueueFullError)) return next(error);
    }
    const message = queued === variants.length
      ? `Se enviaron ${queued} usuarios probables a Maigret.`
      : `La cola de Maigret está llena: se enviaron ${queued} de ${variants.length} usuarios.`;
    return res.redirect('/maigret?' + new URLSearchParams({ message, type: queued ? 'success' : 'error' }));
  });

  return router;
}
