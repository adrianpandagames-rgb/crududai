import * as XLSX from 'xlsx';
import { fileGroupOf, visibleFiles } from './fileGroups.js';
import { IMAGE_TYPES, detectImageType } from './imageService.js';
import { buildNameIndex, normalizeName, searchNameIndex } from './nameSearchService.js';

export const MAX_LENGTHS = { nombre: 200, direccion: 500, alias: 500, linea: 50 };
const FIELD_NAMES = { nombre: 'nombre', direccion: 'dirección', alias: 'alias OSINT', linea: 'línea' };
export const MAX_IMAGES_PER_PERFIL = 30;
// Only formats every browser can show; the type comes from the file signature.
const PERFIL_IMAGE_TYPES = ['jpeg', 'png', 'gif', 'webp'];
export const perfilImageType = (buffer) => {
  const type = detectImageType(buffer);
  return PERFIL_IMAGE_TYPES.includes(type) ? type : null;
};

// Carriers answer with this text, in the Nombre or Dirección cell, when they have no record of that data.
export const NO_RECORD_PATTERN = /no se encontro registro|^me permito informar/;

const LABELS = {
  nombre: ['nombre', 'nombre del titular', 'nombre del cliente', 'nombre del usuario', 'nombre del suscriptor', 'titular'],
  direccion: ['direccion', 'domicilio', 'direccion del titular', 'domicilio del titular'],
};

const plain = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const ALL_LABELS = Object.values(LABELS).flat();
const isLabel = (value) => ALL_LABELS.includes(plain(value).replace(/:$/, '').trim());

export const lineDigits = (value) => String(value ?? '').replace(/\D/g, '');

// "Nombre: JUAN PÉREZ" in one cell, "Nombre" | "JUAN PÉREZ" in one row, or "Nombre" over its value.
// A cell with the carrier's "no record" answer is skipped, so the other field is still taken.
// Returns null when there is nothing to take.
export function extractTitular(sheets) {
  const found = {};
  for (const rows of sheets) {
    rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      const text = clean(cell);
      const [label, ...rest] = text.split(':');
      const field = Object.keys(LABELS).find((key) => !found[key] && LABELS[key].includes(plain(label)));
      if (!field) return;
      // A row with both labels is a header, so its values are in the row below.
      const headerRow = row.filter(isLabel).length >= 2;
      const right = headerRow ? '' : clean(row.slice(columnIndex + 1).find((next) => clean(next)));
      // Otherwise the value below counts only in a short row, not under a header of many columns.
      const below = headerRow || row.filter((next) => clean(next)).length <= 3 ? clean(rows[rowIndex + 1]?.[columnIndex]) : '';
      const value = [clean(rest.join(':')), right, below].find((candidate) => candidate && !isLabel(candidate));
      if (value && !NO_RECORD_PATTERN.test(plain(value))) found[field] = value;
    }));
  }
  return found.nombre || found.direccion
    ? { nombre: (found.nombre || '').slice(0, MAX_LENGTHS.nombre), direccion: (found.direccion || '').slice(0, MAX_LENGTHS.direccion) }
    : null;
}

export const titularHasNoRecord = (sheets) => sheets.flat(2).some((cell) => NO_RECORD_PATTERN.test(plain(cell)));

export function readXlsxSheets(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return workbook.SheetNames.map((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
    header: 1, defval: '', raw: false, blankrows: false,
  }));
}

// The OSINT alias is how the person shows up on Telegram, WhatsApp and similar apps.
export function validarPerfil({ nombre, direccion, alias, linea }) {
  const perfil = { nombre: clean(nombre), direccion: clean(direccion), alias: clean(alias), linea: clean(linea) };
  if (!perfil.nombre) return { error: 'Escribe el nombre o sube un Excel que lo incluya.' };
  if (!perfil.linea) return { error: 'Escribe la línea telefónica.' };
  const tooLong = Object.keys(MAX_LENGTHS).find((field) => perfil[field].length > MAX_LENGTHS[field]);
  if (tooLong) return { error: `El campo ${FIELD_NAMES[tooLong]} es demasiado largo.` };
  return { perfil };
}

// A phone number query: at least seven digits once spaces, dashes and parentheses are removed.
export const isPhoneQuery = (query) => /^\+?[\d\s().-]+$/.test(String(query).trim()) && lineDigits(query).length >= 7;

// Profiles belong to the creator's group, like uploaded files; administrators see them all.
export function createPerfilesStore(pool) {
  let storage;
  const initialize = () => {
    if (!storage) storage = pool.query(`CREATE TABLE IF NOT EXISTS perfiles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(200) NOT NULL,
      direccion VARCHAR(500) NOT NULL DEFAULT '',
      linea VARCHAR(50) NOT NULL,
      linea_digitos VARCHAR(50) NOT NULL,
      origen VARCHAR(20) NOT NULL DEFAULT 'manual',
      user_id BIGINT NULL,
      owner_group VARCHAR(10) NOT NULL DEFAULT 'general',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX perfiles_linea_digitos (linea_digitos)
    )`).then(async () => {
      const [columns] = await pool.query('SHOW COLUMNS FROM perfiles');
      if (!columns.some((column) => column.Field === 'alias_osint')) {
        await pool.query("ALTER TABLE perfiles ADD COLUMN alias_osint VARCHAR(500) NOT NULL DEFAULT '' AFTER direccion");
      }
    }).then(() => pool.query(`CREATE TABLE IF NOT EXISTS perfil_imagenes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      perfil_id BIGINT UNSIGNED NOT NULL,
      image_type VARCHAR(10) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      data LONGBLOB NOT NULL,
      user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT perfil_imagenes_perfil FOREIGN KEY (perfil_id) REFERENCES perfiles (id)
    )`)).catch((error) => { storage = null; throw error; });
    return storage;
  };

  const select = `SELECT p.id, p.nombre, p.direccion, p.alias_osint AS alias, p.linea, p.origen, u.email AS createdBy,
    DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i') AS createdAt,
    (SELECT GROUP_CONCAT(i.id ORDER BY i.id) FROM perfil_imagenes i WHERE i.perfil_id = p.id) AS imagenIds
    FROM perfiles p LEFT JOIN users u ON u.id = p.user_id`;
  const withImages = (rows) => rows.map(({ imagenIds, ...row }) => ({
    ...row, imagenes: imagenIds ? String(imagenIds).split(',').map(Number) : [],
  }));

  const list = async (session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [rows] = await pool.execute(`${select} WHERE ${scope.where} ORDER BY p.created_at DESC, p.id DESC`, scope.values);
    return withImages(rows);
  };

  const create = async (perfil, session, origen = 'manual') => {
    await initialize();
    const [result] = await pool.execute(
      `INSERT INTO perfiles (nombre, direccion, linea, linea_digitos, origen, user_id, owner_group, alias_osint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [perfil.nombre, perfil.direccion, perfil.linea, lineDigits(perfil.linea), origen, session?.userId ?? null, fileGroupOf(session), perfil.alias || ''],
    );
    return result.insertId;
  };

  // Files uploaded again for the same line and holder do not repeat the profile.
  const createFromFile = async (perfil, session) => {
    await initialize();
    const [rows] = await pool.execute(
      'SELECT nombre FROM perfiles WHERE linea_digitos = ? AND owner_group = ?',
      [lineDigits(perfil.linea), fileGroupOf(session)],
    );
    if (rows.some((row) => normalizeName(row.nombre) === normalizeName(perfil.nombre))) return null;
    return create(perfil, session, 'archivo');
  };

  const get = async (id, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [rows] = await pool.execute(`SELECT p.id, p.nombre, p.direccion, p.alias_osint AS alias, p.linea FROM perfiles p WHERE p.id = ? AND ${scope.where}`,
      [id, ...scope.values]);
    return rows[0] || null;
  };

  const update = async (id, perfil, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [result] = await pool.execute(`UPDATE perfiles p SET p.nombre = ?, p.direccion = ?, p.alias_osint = ?, p.linea = ?, p.linea_digitos = ?
      WHERE p.id = ? AND ${scope.where}`, [perfil.nombre, perfil.direccion, perfil.alias, perfil.linea, lineDigits(perfil.linea), id, ...scope.values]);
    return result.affectedRows === 1;
  };

  // Images are deleted only one by one with their own button, so a profile that still has any stays.
  const remove = async (id, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [result] = await pool.execute(`DELETE p FROM perfiles p WHERE p.id = ? AND ${scope.where}
      AND NOT EXISTS (SELECT 1 FROM perfil_imagenes i WHERE i.perfil_id = p.id)`, [id, ...scope.values]);
    if (result.affectedRows === 1) return 'eliminado';
    const [rows] = await pool.execute(`SELECT p.id FROM perfiles p WHERE p.id = ? AND ${scope.where}`, [id, ...scope.values]);
    return rows[0] ? 'con-imagenes' : 'no-encontrado';
  };

  // By phone number, or by name with the same matching rules as the official lists.
  const search = async (query, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    if (isPhoneQuery(query)) {
      const digits = lineDigits(query).slice(-10);
      const [rows] = await pool.execute(`${select} WHERE ${scope.where} AND p.linea_digitos LIKE ? ORDER BY p.created_at DESC LIMIT 50`,
        [...scope.values, `%${digits}%`]);
      return withImages(rows).map((row) => ({ ...row, exact: true }));
    }
    const [rows] = await pool.execute(`${select} WHERE ${scope.where}`, scope.values);
    const byId = new Map(withImages(rows).map((row) => [String(row.id), row]));
    const index = buildNameIndex(rows.map((row) => ({ source: 'perfil', sourceId: String(row.id), name: row.nombre, details: {} })));
    return searchNameIndex(index, query).map((hit) => ({ ...byId.get(hit.sourceId), exact: hit.exact }));
  };

  // Adds images to a profile the user can see; returns how many were saved, or null without access.
  const addImages = async (perfilId, images, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [rows] = await pool.execute(`SELECT p.id, (SELECT COUNT(*) FROM perfil_imagenes i WHERE i.perfil_id = p.id) AS total
      FROM perfiles p WHERE p.id = ? AND ${scope.where}`, [perfilId, ...scope.values]);
    if (!rows[0]) return null;
    const room = Math.max(0, MAX_IMAGES_PER_PERFIL - Number(rows[0].total));
    const saved = images.slice(0, room);
    for (const image of saved) {
      await pool.execute('INSERT INTO perfil_imagenes (perfil_id, image_type, original_name, data, user_id) VALUES (?, ?, ?, ?, ?)',
        [perfilId, image.type, image.name.slice(0, 255), image.buffer, session?.userId ?? null]);
    }
    return saved.length;
  };

  const getImage = async (id, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [rows] = await pool.execute(`SELECT i.image_type AS type, i.data FROM perfil_imagenes i
      JOIN perfiles p ON p.id = i.perfil_id WHERE i.id = ? AND ${scope.where}`, [id, ...scope.values]);
    return rows[0] && IMAGE_TYPES[rows[0].type] ? { mime: IMAGE_TYPES[rows[0].type].mime, data: rows[0].data } : null;
  };

  const removeImage = async (id, session) => {
    await initialize();
    const scope = visibleFiles(session, 'p');
    const [result] = await pool.execute(`DELETE i FROM perfil_imagenes i JOIN perfiles p ON p.id = i.perfil_id
      WHERE i.id = ? AND ${scope.where}`, [id, ...scope.values]);
    return result.affectedRows === 1;
  };

  return { initialize, list, create, createFromFile, get, update, remove, search, addImages, getImage, removeImage };
}
