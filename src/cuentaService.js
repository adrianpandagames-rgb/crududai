import sharp from 'sharp';
import { detectImageType } from './imageService.js';

export const MAX_NOMBRE_LENGTH = 80;
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;
const FOTO_TYPES = ['jpeg', 'png', 'webp', 'gif'];
const FOTO_SIZE = 256;

export const temas = { sistema: 'Igual que el sistema', claro: 'Claro', oscuro: 'Oscuro' };

// Pages a person may land on after signing in; UECS cannot open Métricas or Tareas.
const paginasInicio = [
  ['/Crud', 'Líneas'], ['/tareas', 'Tareas', true], ['/metricas', 'Métricas', true], ['/imei', 'IMEI'], ['/perfiles', 'Perfiles'],
  ['/ubicaciones', 'Ubicaciones'], ['/planeacion-geografica', 'Planeación geográfica'], ['/ruta', 'Ruta'],
];
export const paginasInicioPara = (role) => paginasInicio
  .filter(([, , noUecs]) => !(noUecs && role === 'uecs'))
  .map(([path, label]) => ({ path, label }));

export const preferenciasPorDefecto = { tema: 'sistema', inicio: '/Crud', avisos: true };

// Saved preferences are re-checked on every read, so a role change never leaves someone landing on a page they lost.
export function normalizarPreferencias(raw, role) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = {}; }
  }
  value = value && typeof value === 'object' ? value : {};
  const inicio = paginasInicioPara(role).some(({ path }) => path === value.inicio) ? value.inicio : preferenciasPorDefecto.inicio;
  return {
    tema: Object.hasOwn(temas, value.tema) ? value.tema : preferenciasPorDefecto.tema,
    inicio,
    avisos: value.avisos !== false && value.avisos !== '0',
  };
}

// Empty means "use the e-mail"; inner runs of spaces are collapsed.
export function validarNombre(value) {
  const nombre = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (nombre.length > MAX_NOMBRE_LENGTH) return { error: `El nombre admite hasta ${MAX_NOMBRE_LENGTH} caracteres.` };
  if (/[<>]/.test(nombre)) return { error: 'El nombre no puede contener los signos < o >.' };
  return { nombre: nombre || null };
}

// The photo is re-encoded as a small square WebP, which drops EXIF data (such as GPS) and anything hidden in the file.
export async function procesarFoto(buffer) {
  if (!FOTO_TYPES.includes(detectImageType(buffer))) return { error: 'La foto debe ser JPG, PNG, WebP o GIF.' };
  try {
    const data = await sharp(buffer, { limitInputPixels: 40_000_000, animated: false })
      .rotate().resize(FOTO_SIZE, FOTO_SIZE, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    return { data };
  } catch {
    return { error: 'No fue posible leer la imagen.' };
  }
}

export function createCuentaStore(pool) {
  let storage;
  const initialize = () => {
    if (!storage) storage = pool.query(`CREATE TABLE IF NOT EXISTS user_cuentas (
      user_id INT NOT NULL PRIMARY KEY,
      nombre VARCHAR(${MAX_NOMBRE_LENGTH}) NULL,
      foto MEDIUMBLOB NULL,
      foto_actualizada DATETIME NULL,
      preferencias TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch((error) => { storage = null; throw error; });
    return storage;
  };
  // Column names come only from the calls below, never from the request.
  const upsert = async (userId, column, value) => {
    await initialize();
    await pool.execute(
      `INSERT INTO user_cuentas (user_id, ${column}) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE ${column} = VALUES(${column})`,
      [userId, value],
    );
  };

  return {
    initialize,
    async get(userId, role) {
      await initialize();
      const [rows] = await pool.execute(
        'SELECT nombre, UNIX_TIMESTAMP(foto_actualizada) AS fotoVersion, preferencias FROM user_cuentas WHERE user_id = ?',
        [userId],
      );
      const row = rows[0] || {};
      return {
        nombre: row.nombre || '',
        fotoVersion: row.fotoVersion ? String(row.fotoVersion) : '',
        preferencias: normalizarPreferencias(row.preferencias, role),
      };
    },
    setNombre: (userId, nombre) => upsert(userId, 'nombre', nombre),
    setPreferencias: (userId, preferencias) => upsert(userId, 'preferencias', JSON.stringify(preferencias)),
    // The time doubles as the image's version in its URL, so a new photo is not served from the browser cache.
    async setFoto(userId, data) {
      await initialize();
      await pool.execute(
        `INSERT INTO user_cuentas (user_id, foto, foto_actualizada) VALUES (?, ?, IF(? IS NULL, NULL, NOW()))
         ON DUPLICATE KEY UPDATE foto = VALUES(foto), foto_actualizada = VALUES(foto_actualizada)`,
        [userId, data, data],
      );
    },
    async getFoto(userId) {
      await initialize();
      const [rows] = await pool.execute('SELECT foto FROM user_cuentas WHERE user_id = ? AND foto IS NOT NULL', [userId]);
      return rows[0]?.foto || null;
    },
  };
}
