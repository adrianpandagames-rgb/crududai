import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { fileGroupOf, visibleFiles } from './fileGroups.js';
import { IMAGE_TYPES, createPublicCopy, detectImageType, hashImage, readImageMetadata, reverseSearchLinks } from './imageService.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PUBLIC_LINK_MINUTES = 60;
const RETENTION_DAYS = 7;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storages = new WeakMap();
const initializeImageStorage = (pool) => {
  if (!storages.has(pool)) {
    storages.set(pool, pool.query(`CREATE TABLE IF NOT EXISTS imagen_busquedas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      image_uuid CHAR(36) NOT NULL UNIQUE,
      user_id BIGINT NOT NULL,
      owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
      original_name VARCHAR(255) NOT NULL,
      image_type VARCHAR(10) NOT NULL,
      size_bytes INT UNSIGNED NOT NULL,
      sha256 CHAR(64) NOT NULL,
      md5 CHAR(32) NOT NULL,
      image LONGBLOB NOT NULL,
      public_image LONGBLOB NOT NULL,
      public_stripped TINYINT(1) NOT NULL DEFAULT 0,
      metadata LONGTEXT NULL,
      has_gps TINYINT(1) NOT NULL DEFAULT 0,
      public_token CHAR(64) NULL UNIQUE,
      public_expires_at DATETIME NULL,
      public_hits INT UNSIGNED NOT NULL DEFAULT 0,
      public_last_access DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      INDEX imagen_group_created (owner_group, created_at),
      INDEX imagen_expires (expires_at)
    )`).then(() => true).catch((error) => { storages.delete(pool); throw error; }));
  }
  return storages.get(pool);
};

const newToken = () => crypto.randomBytes(32).toString('hex');

// Search engines download the image from this address, so it needs no session; the random token
// expires after an hour and serves the copy without metadata.
export function createPublicImageRouter(pool) {
  const router = express.Router();
  router.get('/:file', async (req, res) => {
    const match = /^([0-9a-f]{64})(\.[a-z]+)?$/.exec(req.params.file);
    res.setHeader('X-Robots-Tag', 'noindex, noimageindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    if (!match) return res.status(404).end();
    try {
      await initializeImageStorage(pool);
      const [rows] = await pool.execute(`SELECT image_type, public_image FROM imagen_busquedas
        WHERE public_token = ? AND public_expires_at > NOW() AND expires_at > NOW()`, [match[1]]);
      if (!rows[0]) return res.status(404).end();
      await pool.execute(`UPDATE imagen_busquedas SET public_hits = public_hits + 1, public_last_access = NOW()
        WHERE public_token = ?`, [match[1]]);
      res.setHeader('Content-Type', IMAGE_TYPES[rows[0].image_type].mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(rows[0].public_image);
    } catch {
      return res.status(503).end();
    }
  });
  return router;
}

export function createImagenesRouter(pool, { publicBaseUrl = process.env.PUBLIC_BASE_URL } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2 } }).single('imagen');
  const redirect = (res, message, type = 'error') => res.redirect('/imagenes?' + new URLSearchParams({ message, type }));
  const baseUrl = (req) => (publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const findVisible = async (session, id, columns) => {
    if (!UUID_PATTERN.test(id)) return null;
    const scope = visibleFiles(session, 'i');
    const [rows] = await pool.execute(`SELECT ${columns} FROM imagen_busquedas i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.image_uuid = ? AND ${scope.where} AND i.expires_at > NOW()`, [id, ...scope.values]);
    return rows[0] ?? null;
  };

  router.use(async (req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    // OpenStreetMap tiles need a Referer; cross-origin requests send only the site origin.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      await initializeImageStorage(pool);
      await pool.query('DELETE FROM imagen_busquedas WHERE expires_at <= NOW()');
      next();
    } catch {
      res.status(503).send('No fue posible acceder a las imágenes.');
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const scope = visibleFiles(req.session, 'i');
      const [images] = await pool.execute(`SELECT i.image_uuid AS id, i.original_name AS name, i.has_gps AS hasGps,
        i.size_bytes AS size, u.email AS uploadedBy, DATE_FORMAT(i.created_at, '%Y-%m-%d %H:%i') AS createdAt
        FROM imagen_busquedas i LEFT JOIN users u ON u.id = i.user_id
        WHERE ${scope.where} ORDER BY i.id DESC LIMIT 200`, scope.values);
      return res.render('pages/imagenes', {
        images, retentionDays: RETENTION_DAYS, maxMegabytes: MAX_IMAGE_BYTES / 1024 / 1024,
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/subir', (req, res, next) => upload(req, res, (error) => (error
    ? redirect(res, error.code === 'LIMIT_FILE_SIZE' ? `La imagen supera el límite de ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` : 'No fue posible recibir la imagen.')
    : next())), async (req, res, next) => {
    if (!req.file) return redirect(res, 'Selecciona una imagen.');
    const type = detectImageType(req.file.buffer);
    if (!type) return redirect(res, 'El archivo no es una imagen JPG, PNG, GIF, WebP o HEIC.');
    const id = crypto.randomUUID();
    try {
      const metadata = await readImageMetadata(req.file.buffer);
      const publicCopy = createPublicCopy(req.file.buffer, type);
      const hashes = hashImage(req.file.buffer);
      await pool.execute(`INSERT INTO imagen_busquedas (image_uuid, user_id, owner_group, original_name, image_type, size_bytes,
        sha256, md5, image, public_image, public_stripped, metadata, has_gps, public_token, public_expires_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${PUBLIC_LINK_MINUTES} MINUTE),
        DATE_ADD(NOW(), INTERVAL ${RETENTION_DAYS} DAY))`, [
        id, req.session.userId, fileGroupOf(req.session), req.file.originalname.slice(0, 255), type, req.file.size,
        hashes.sha256, hashes.md5, req.file.buffer, publicCopy.buffer, publicCopy.stripped ? 1 : 0,
        JSON.stringify(metadata), metadata.gps ? 1 : 0, IMAGE_TYPES[type].searchable ? newToken() : null,
      ]);
    } catch (error) {
      return next(error);
    }
    return res.redirect(`/imagenes/${id}`);
  });

  router.post('/:id/enlace', async (req, res, next) => {
    try {
      const image = await findVisible(req.session, req.params.id, 'i.image_type');
      if (!image || !IMAGE_TYPES[image.image_type].searchable) return res.status(404).send('Imagen no encontrada.');
      await pool.execute(`UPDATE imagen_busquedas SET public_token = ?,
        public_expires_at = DATE_ADD(NOW(), INTERVAL ${PUBLIC_LINK_MINUTES} MINUTE) WHERE image_uuid = ?`, [newToken(), req.params.id]);
      return res.redirect(`/imagenes/${req.params.id}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/revocar', async (req, res, next) => {
    try {
      const image = await findVisible(req.session, req.params.id, 'i.image_uuid');
      if (!image) return res.status(404).send('Imagen no encontrada.');
      await pool.execute('UPDATE imagen_busquedas SET public_token = NULL, public_expires_at = NULL WHERE image_uuid = ?', [req.params.id]);
      return res.redirect(`/imagenes/${req.params.id}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/eliminar/:id', async (req, res) => {
    try {
      if (!UUID_PATTERN.test(req.params.id)) return redirect(res, 'Imagen no encontrada.');
      const scope = visibleFiles(req.session, 'i');
      const [result] = await pool.execute(`DELETE i FROM imagen_busquedas i WHERE i.image_uuid = ? AND ${scope.where}`,
        [req.params.id, ...scope.values]);
      return redirect(res, result.affectedRows ? 'Imagen eliminada.' : 'Imagen no encontrada.', result.affectedRows ? 'success' : 'error');
    } catch {
      return redirect(res, 'No fue posible eliminar la imagen.');
    }
  });

  router.get('/:id/archivo', async (req, res, next) => {
    try {
      const image = await findVisible(req.session, req.params.id, 'i.image_type, i.image');
      if (!image) return res.status(404).send('Imagen no encontrada.');
      res.setHeader('Content-Type', IMAGE_TYPES[image.image_type].mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(image.image);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const image = await findVisible(req.session, req.params.id, `i.image_uuid AS id, i.original_name AS name, i.image_type AS type,
        i.size_bytes AS size, i.sha256, i.md5, i.public_stripped AS stripped, i.metadata, i.public_token AS token,
        i.public_expires_at > NOW() AS linkActive, DATE_FORMAT(i.public_expires_at, '%H:%i') AS linkExpiresAt,
        i.public_hits AS hits, DATE_FORMAT(i.public_last_access, '%Y-%m-%d %H:%i') AS lastAccess,
        u.email AS uploadedBy, DATE_FORMAT(i.created_at, '%Y-%m-%d %H:%i') AS createdAt,
        DATE_FORMAT(i.expires_at, '%Y-%m-%d') AS expiresAt`);
      if (!image) return res.status(404).send('Imagen no encontrada.');
      const metadata = JSON.parse(image.metadata || '{"summary":[],"gps":null,"all":[]}');
      const searchable = IMAGE_TYPES[image.type].searchable;
      const publicUrl = image.token && image.linkActive
        ? `${baseUrl(req)}/imagen-publica/${image.token}.${IMAGE_TYPES[image.type].extension}` : null;
      return res.render('pages/imagen-resultado', {
        image, metadata, searchable, publicUrl,
        links: publicUrl ? reverseSearchLinks(publicUrl) : [],
        linkMinutes: PUBLIC_LINK_MINUTES,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
