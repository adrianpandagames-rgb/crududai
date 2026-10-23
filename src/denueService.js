// Business directory from INEGI's DENUE (Directorio Estadístico Nacional de Unidades Económicas), loaded from its
// per-state CSV downloads into MySQL and searched by business name or razón social.
import readline from 'node:readline';
import zlib from 'node:zlib';
import { parseCsvRow } from './csvUtils.js';
import { normalizeName } from './nameSearchService.js';

const DOWNLOAD_BASE = 'https://www.inegi.org.mx/contenidos/masiva/denue';
// Estado de México is published in two parts.
export const DENUE_FILES = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15_1', '15_2', '16',
  '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32',
];
// INEGI publishes the DENUE about twice a year.
const REFRESH_AFTER_DAYS = 30;
const RETRY_AFTER_ERROR_HOURS = 6;
const DOWNLOAD_TIMEOUT_MS = 300000;
const DOWNLOAD_ATTEMPTS = 3;
const INSERT_CHUNK = 1000;
const CANDIDATES = 500;
const MAX_RESULTS = 50;
const SOURCE = 'denue';
const TABLE = 'denue_negocios';

const STATES = {
  aguascalientes: '01', 'baja california': '02', 'baja california sur': '03', campeche: '04', coahuila: '05',
  colima: '06', chiapas: '07', chihuahua: '08', 'ciudad de mexico': '09', cdmx: '09', durango: '10',
  guanajuato: '11', guerrero: '12', hidalgo: '13', jalisco: '14', 'estado de mexico': '15', edomex: '15',
  michoacan: '16', morelos: '17', nayarit: '18', 'nuevo leon': '19', oaxaca: '20', puebla: '21', queretaro: '22',
  'quintana roo': '23', 'san luis potosi': '24', sinaloa: '25', sonora: '26', tabasco: '27', tamaulipas: '28',
  tlaxcala: '29', veracruz: '30', yucatan: '31', zacatecas: '32',
};

// The longest state name contained in the text wins, so "Baja California Sur" is not read as "Baja California".
const stateIn = (place) => {
  const text = ` ${normalizeName(place)} `;
  return Object.keys(STATES).filter((state) => text.includes(` ${state} `)).sort((a, b) => b.length - a.length)[0];
};

export const stateCodeFor = (place) => STATES[stateIn(place)] ?? '00';

// What is left of the place once the state is removed, e.g. the city in "Hermosillo, Sonora".
const cityIn = (place) => {
  const state = stateIn(place);
  const text = ` ${normalizeName(place)} `;
  return (state ? text.replace(` ${state} `, ' ') : text).trim();
};

// MySQL's full-text index skips words under three letters and its default stopwords; those are checked afterwards.
const FULLTEXT_STOPWORDS = new Set(['about', 'and', 'are', 'com', 'for', 'from', 'how', 'that', 'the', 'this', 'und',
  'was', 'what', 'when', 'where', 'who', 'will', 'with', 'www']);
export const fulltextQuery = (words) => words
  .filter((word) => word.length >= 3 && !FULLTEXT_STOPWORDS.has(word))
  .map((word) => `+${word}`)
  .join(' ');

// Returns the inflated contents of the first entry whose name matches, reading the ZIP's central directory.
export function zipEntryStream(buffer, pattern) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('El archivo descargado no es un ZIP.');
  let offset = buffer.readUInt32LE(end + 16);
  for (let entry = buffer.readUInt16LE(end + 10); entry > 0; entry--) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (pattern.test(name)) {
      const method = buffer.readUInt16LE(offset + 10);
      if (method !== 8) throw new Error(`El ZIP usa un método de compresión no soportado (${method}).`);
      const local = buffer.readUInt32LE(offset + 42);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const stream = zlib.createInflateRaw();
      stream.end(buffer.subarray(start, start + buffer.readUInt32LE(offset + 20)));
      return stream;
    }
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  throw new Error('El ZIP no trae el CSV de negocios.');
}

// Yields one parsed row per record; a quoted field may span lines.
export async function* csvRows(stream) {
  stream.setEncoding('latin1');
  let pending = '';
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    pending = pending ? `${pending}\n${line}` : line;
    if ((pending.match(/"/g)?.length ?? 0) % 2 === 1) continue;
    if (pending.trim()) yield parseCsvRow(pending);
    pending = '';
  }
}

const joined = (...parts) => parts.filter(Boolean).join(' ');

// Turns a CSV row into the values of one table row, in COLUMNS order.
export function toBusiness(header, values) {
  const field = (name) => values[header.indexOf(name)]?.trim() ?? '';
  const nombre = field('nom_estab');
  const razonSocial = field('raz_social');
  const id = Number(field('id'));
  if (!Number.isSafeInteger(id) || id <= 0 || (!nombre && !razonSocial)) return null;
  const coordinate = (name) => {
    const value = Number.parseFloat(field(name));
    return Number.isFinite(value) ? value : null;
  };
  return [
    id,
    nombre.slice(0, 255),
    razonSocial.slice(0, 255),
    field('nombre_act').slice(0, 255),
    field('per_ocu').slice(0, 40),
    joined(field('tipo_vial'), field('nom_vial'),
      field('numero_ext') && `#${field('numero_ext')}${field('letra_ext')}`,
      field('numero_int') && `int. ${field('numero_int')}${field('letra_int')}`).slice(0, 300),
    joined(field('tipo_asent'), field('nomb_asent')).slice(0, 200),
    field('cod_postal').slice(0, 5),
    field('cve_ent').padStart(2, '0').slice(0, 2),
    field('entidad').slice(0, 60),
    field('municipio').slice(0, 120),
    field('localidad').slice(0, 150),
    field('telefono').slice(0, 40),
    field('correoelec').slice(0, 150),
    field('www').slice(0, 150),
    coordinate('latitud'),
    coordinate('longitud'),
    normalizeName(`${nombre} ${razonSocial}`).slice(0, 520),
  ];
}

const COLUMNS = 'id, nombre, razon_social, actividad, personal, direccion, colonia, cp, cve_ent, entidad, municipio, localidad, telefono, correo, sitio, latitud, longitud, busqueda';

const createTable = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INT UNSIGNED NOT NULL PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  razon_social VARCHAR(255) NOT NULL,
  actividad VARCHAR(255) NOT NULL,
  personal VARCHAR(40) NOT NULL,
  direccion VARCHAR(300) NOT NULL,
  colonia VARCHAR(200) NOT NULL,
  cp VARCHAR(5) NOT NULL,
  cve_ent CHAR(2) NOT NULL,
  entidad VARCHAR(60) NOT NULL,
  municipio VARCHAR(120) NOT NULL,
  localidad VARCHAR(150) NOT NULL,
  telefono VARCHAR(40) NOT NULL,
  correo VARCHAR(150) NOT NULL,
  sitio VARCHAR(150) NOT NULL,
  latitud DECIMAL(10,7) NULL,
  longitud DECIMAL(10,7) NULL,
  busqueda VARCHAR(520) NOT NULL
)`;

export function createDenueDirectory(pool, { fetchImpl = fetch, files = DENUE_FILES, minimumPerFile = 1000 } = {}) {
  let storage;
  let refreshing = null;
  let progress = null;

  // The table and its full-text index exist from the start, so a search before the first load finds nothing instead of failing.
  const initialize = () => {
    if (!storage) storage = (async () => {
      await pool.query(createTable(TABLE));
      const [indexes] = await pool.query(`SHOW INDEX FROM ${TABLE} WHERE Key_name = 'denue_busqueda'`);
      if (indexes.length === 0) await pool.query(`ALTER TABLE ${TABLE} ADD FULLTEXT INDEX denue_busqueda (busqueda)`);
    })().catch((error) => { storage = null; throw error; });
    return storage;
  };

  const download = async (file) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetchImpl(`${DOWNLOAD_BASE}/denue_${file}_csv.zip`,
          { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'User-Agent': 'CRUDUDAI/1.0' } });
        if (!response.ok) throw new Error(`La descarga del archivo ${file} respondió ${response.status}.`);
        const buffer = Buffer.from(await response.arrayBuffer());
        // INEGI answers a missing file with an HTML page instead of a 404.
        if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error(`El archivo ${file} no llegó como ZIP.`);
        return buffer;
      } catch (error) {
        if (attempt >= DOWNLOAD_ATTEMPTS) throw error;
      }
    }
  };

  // Loads every state into a new table and swaps it in at the end, so searches keep working with the previous data.
  const loadAll = async () => {
    const staging = `${TABLE}_nuevo`;
    const connection = await pool.getConnection();
    let total = 0;
    try {
      await connection.query(`DROP TABLE IF EXISTS ${staging}`);
      await connection.query(createTable(staging));
      for (const [position, file] of files.entries()) {
        progress = { file: position + 1, files: files.length, entries: total };
        let header = null;
        let batch = [];
        const insert = async () => {
          if (batch.length === 0) return;
          await connection.query(`INSERT IGNORE INTO ${staging} (${COLUMNS}) VALUES ?`, [batch]);
          total += batch.length;
          batch = [];
        };
        for await (const values of csvRows(zipEntryStream(await download(file), /conjunto_de_datos\/.*\.csv$/i))) {
          if (!header) { header = values; continue; }
          const business = toBusiness(header, values);
          if (business) batch.push(business);
          if (batch.length >= INSERT_CHUNK) await insert();
        }
        await insert();
        if (!header) throw new Error(`El archivo ${file} viene vacío.`);
      }
      // A download that suddenly comes back nearly empty is broken, not a real update.
      if (total < files.length * minimumPerFile) throw new Error(`La descarga solo trae ${total} negocios.`);
      progress = { file: files.length, files: files.length, entries: total, indexing: true };
      await connection.query(`ALTER TABLE ${staging} ADD FULLTEXT INDEX denue_busqueda (busqueda)`);
      await connection.query(`DROP TABLE IF EXISTS ${TABLE}_anterior`);
      await connection.query(`RENAME TABLE ${TABLE} TO ${TABLE}_anterior, ${staging} TO ${TABLE}`);
      await connection.query(`DROP TABLE ${TABLE}_anterior`);
      return total;
    } catch (error) {
      await connection.query(`DROP TABLE IF EXISTS ${staging}`).catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  };

  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await pool.query(`INSERT INTO nombre_listas_fuentes (source, attempted_at) VALUES (?, NOW())
        ON DUPLICATE KEY UPDATE attempted_at = NOW()`, [SOURCE]);
      try {
        const total = await loadAll();
        await pool.query('UPDATE nombre_listas_fuentes SET updated_at = NOW(), entries = ?, error_message = NULL WHERE source = ?',
          [total, SOURCE]);
      } catch (error) {
        await pool.query('UPDATE nombre_listas_fuentes SET error_message = ? WHERE source = ?',
          [String(error.message || 'No fue posible descargar el DENUE.').slice(0, 500), SOURCE]).catch(() => {});
        throw error;
      } finally {
        refreshing = null;
        progress = null;
      }
    })();
    return refreshing;
  };

  const status = async () => {
    const [rows] = await pool.query(`SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') AS updatedAt, entries, error_message AS error,
      updated_at IS NULL OR updated_at < NOW() - INTERVAL ${REFRESH_AFTER_DAYS} DAY AS stale,
      attempted_at IS NOT NULL AND attempted_at > NOW() - INTERVAL ${RETRY_AFTER_ERROR_HOURS} HOUR AS recentAttempt
      FROM nombre_listas_fuentes WHERE source = ?`, [SOURCE]);
    const row = rows[0];
    return {
      label: 'DENUE (negocios registrados por INEGI)',
      updatedAt: row?.updatedAt ?? null,
      entries: Number(row?.entries ?? 0),
      error: row?.error ?? null,
      stale: !row || Number(row.stale) === 1,
      recentAttempt: Number(row?.recentAttempt ?? 0) === 1,
      refreshing: Boolean(refreshing),
      progress,
    };
  };

  // A stale directory reloads in the background; a failed load waits a few hours before retrying.
  const refreshStale = async () => {
    const current = await status();
    if (current.stale && !current.refreshing && !(current.error && current.recentAttempt)) {
      refresh().catch((error) => console.error('No se pudo actualizar el DENUE:', error.message));
    }
  };

  // Every word of the query must appear in the business name or razón social; one letter matches a word that starts with it.
  const search = async (name, place = '') => {
    const words = normalizeName(name).split(' ').filter(Boolean);
    const required = fulltextQuery(words);
    if (!required) return [];
    const state = stateCodeFor(place);
    const city = cityIn(place);
    // Businesses in the requested city come first even when a common surname matches thousands across the country.
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM ${TABLE}
      WHERE MATCH (busqueda) AGAINST (? IN BOOLEAN MODE)${state === '00' ? '' : ' AND cve_ent = ?'}
      ${city ? 'ORDER BY (municipio = ? OR localidad = ?) DESC' : ''}
      LIMIT ${CANDIDATES}`, [required, ...(state === '00' ? [] : [state]), ...(city ? [city, city] : [])]);
    return rows
      .filter((row) => {
        const text = ` ${row.busqueda} `;
        return words.every((word) => text.includes(word.length === 1 ? ` ${word}` : ` ${word} `));
      })
      .map((row) => ({
        id: String(row.id),
        nombre: row.nombre,
        razonSocial: row.razon_social,
        actividad: row.actividad,
        personal: row.personal,
        direccion: row.direccion,
        colonia: row.colonia,
        cp: row.cp,
        ubicacion: [...new Set([row.localidad, row.municipio, row.entidad].filter(Boolean))].join(', '),
        telefono: row.telefono,
        correo: row.correo,
        sitio: row.sitio,
        latitud: row.latitud === null ? '' : String(row.latitud),
        longitud: row.longitud === null ? '' : String(row.longitud),
        inPlace: Boolean(city) && ` ${normalizeName(`${row.localidad} ${row.municipio}`)} `.includes(` ${city} `),
      }))
      .sort((a, b) => Number(b.inPlace) - Number(a.inPlace))
      .slice(0, MAX_RESULTS);
  };

  return { initialize, refresh, refreshStale, status, search };
}
