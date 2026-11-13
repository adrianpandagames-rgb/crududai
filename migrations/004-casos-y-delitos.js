import { columnExists, foreignKeyExists, quoteName, tableExists } from './helpers.js';

// A case is a NUC within a year: the same number can belong to different cases in different years. Lines
// (objetivo, objetivoImei) carry both, so they point to their case; the office tables do not store the year yet
// and are linked later. Each line keeps its own delito, since the MP may reclassify along the case; the delitos
// table is an open catalog of the wordings in use. Only adds tables and columns: the nuc, ano and delito text
// columns stay as they are.

// Kept here rather than imported, so the migration stays as it ran even if the app's rule changes.
const normalizarDelito = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);

const COLUMNAS = [
  { table: 'objetivo', column: 'caso_id', ref: 'casos', fk: 'objetivo_caso' },
  { table: 'objetivo', column: 'delito_id', ref: 'delitos', fk: 'objetivo_delito' },
  { table: 'objetivoImei', column: 'caso_id', ref: 'casos', fk: 'objetivoImei_caso' },
];

export default {
  id: '004-casos-y-delitos',
  descripcion: 'Crea casos (NUC + año) y el catálogo de delitos, y enlaza las líneas con ellos.',
  async check(db) {
    const problems = [];
    for (const table of ['objetivo', 'objetivoImei']) {
      if (!await tableExists(db, table)) {
        problems.push(`no existe la tabla ${table}.`);
        continue;
      }
      const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${quoteName(table)} WHERE CHAR_LENGTH(TRIM(nuc)) > 50`);
      if (Number(n)) problems.push(`${table} tiene ${n} NUC de más de 50 caracteres.`);
    }
    return problems;
  },
  async up(db, { log }) {
    await db.query(`CREATE TABLE IF NOT EXISTS casos (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nuc VARCHAR(50) NOT NULL,
      ano YEAR NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY casos_nuc_ano (nuc, ano)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await db.query(`CREATE TABLE IF NOT EXISTS delitos (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY delitos_nombre (nombre)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    for (const { table, column } of COLUMNAS) {
      if (!await columnExists(db, table, column)) {
        await db.query(`ALTER TABLE ${quoteName(table)} ADD COLUMN ${quoteName(column)} INT NULL, ADD INDEX ${quoteName(`${table}_${column}`)} (${quoteName(column)})`);
      }
    }

    // Cases: one per NUC and year found in the lines.
    await db.query(`INSERT IGNORE INTO casos (nuc, ano)
      SELECT TRIM(nuc), ano FROM objetivo WHERE ano IS NOT NULL AND TRIM(nuc) <> ''
      UNION SELECT TRIM(nuc), ano FROM objetivoImei WHERE ano IS NOT NULL AND TRIM(nuc) <> ''`);
    for (const table of ['objetivo', 'objetivoImei']) {
      await db.query(`UPDATE ${quoteName(table)} o JOIN casos c ON c.nuc = TRIM(o.nuc) AND c.ano = o.ano
        SET o.caso_id = c.id WHERE o.caso_id IS NULL`);
    }

    // Delitos: the most used spelling of each wording enters first, so it is the one kept when others differ
    // only in spaces, case or accents; on a tie, the one with accents. Counted per exact spelling (BINARY),
    // since grouping by the collation would pick any of them.
    const [usados] = await db.query(`SELECT delito, COUNT(*) AS n FROM objetivo
      WHERE delito IS NOT NULL AND TRIM(delito) <> '' GROUP BY BINARY delito, delito`);
    const porEscritura = new Map();
    for (const { delito, n } of usados) {
      const nombre = normalizarDelito(delito);
      porEscritura.set(nombre, (porEscritura.get(nombre) || 0) + Number(n));
    }
    const acentos = (texto) => (texto.normalize('NFD').match(/[̀-ͯ]/g) || []).length;
    const orden = [...porEscritura].sort(([a, n], [b, m]) => m - n || acentos(b) - acentos(a));
    for (const [nombre] of orden) await db.query('INSERT IGNORE INTO delitos (nombre) VALUES (?)', [nombre]);
    for (const { delito } of usados) {
      await db.query(`UPDATE objetivo SET delito_id = (SELECT id FROM delitos WHERE nombre = ?)
        WHERE delito = ? AND delito_id IS NULL`, [normalizarDelito(delito), delito]);
    }

    for (const { table, column, ref, fk } of COLUMNAS) {
      if (!await foreignKeyExists(db, table, fk)) {
        await db.query(`ALTER TABLE ${quoteName(table)} ADD CONSTRAINT ${quoteName(fk)} FOREIGN KEY (${quoteName(column)}) REFERENCES ${quoteName(ref)} (id)`);
      }
    }

    const [[{ casos }]] = await db.query('SELECT COUNT(*) AS casos FROM casos');
    const [[{ delitos }]] = await db.query('SELECT COUNT(*) AS delitos FROM delitos');
    const [[{ sinCaso }]] = await db.query('SELECT (SELECT COUNT(*) FROM objetivo WHERE caso_id IS NULL) + (SELECT COUNT(*) FROM objetivoImei WHERE caso_id IS NULL) AS sinCaso');
    const [[{ sinDelito }]] = await db.query("SELECT COUNT(*) AS sinDelito FROM objetivo WHERE delito IS NOT NULL AND TRIM(delito) <> '' AND delito_id IS NULL");
    log(`  ${casos} casos, ${delitos} delitos; líneas sin caso (sin año o NUC): ${sinCaso}; delitos sin enlazar: ${sinDelito}.`);
  },
};
