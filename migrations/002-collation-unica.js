import { quoteName } from './helpers.js';

// Tables mixed utf8mb4_general_ci and utf8mb4_0900_ai_ci, and MySQL refuses to compare text across the two,
// which a join between an office table and the lines would need. Everything moves to the server's default.
// Both ignore case and accents; 0900 does not ignore trailing spaces, so stored values ending in a space would
// stop matching a trimmed search, and the check stops on them. Columns with a binary or non-utf8mb4 collation
// are deliberate (hashes) and keep theirs: a table holding one is reported instead of converted.
export const TARGET = 'utf8mb4_0900_ai_ci';

const pendingTables = async (db) => {
  const [rows] = await db.query(`SELECT DISTINCT t.TABLE_NAME AS name FROM information_schema.TABLES t
    LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
    WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
      AND ((t.TABLE_COLLATION LIKE 'utf8mb4%' AND t.TABLE_COLLATION <> ?)
        OR (c.COLLATION_NAME LIKE 'utf8mb4%' AND c.COLLATION_NAME NOT LIKE '%\\_bin' AND c.COLLATION_NAME <> ?))
    ORDER BY t.TABLE_NAME`, [TARGET, TARGET]);
  return rows.map((row) => row.name);
};

const textColumns = async (db, table) => {
  const [rows] = await db.query(`SELECT COLUMN_NAME AS name, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ? AND COLLATION_NAME IS NOT NULL`, [table]);
  return rows;
};

const uniqueIndexes = async (db, table) => {
  const [rows] = await db.query(`SELECT INDEX_NAME AS name, COLUMN_NAME AS col FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ? AND NON_UNIQUE = 0 AND COLUMN_NAME IS NOT NULL
    ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [table]);
  const indexes = new Map();
  for (const { name, col } of rows) indexes.set(name, [...(indexes.get(name) || []), col]);
  return indexes;
};

export default {
  id: '002-collation-unica',
  descripcion: `Lleva todas las tablas de texto a ${TARGET}.`,
  async check(db) {
    const problems = [];
    for (const table of await pendingTables(db)) {
      const columns = await textColumns(db, table);
      const odd = columns.filter((column) => column.charset !== 'utf8mb4' || column.collation.endsWith('_bin'));
      if (odd.length) {
        problems.push(`${table} tiene columnas con collation propia (${odd.map((column) => `${column.name}: ${column.collation}`).join(', ')}); conviértela a mano.`);
        continue;
      }
      for (const column of columns) {
        const [[{ n }]] = await db.query(
          `SELECT COUNT(*) AS n FROM ${quoteName(table)} WHERE ${quoteName(column.name)} LIKE '% '`,
        );
        if (Number(n)) problems.push(`${table}.${column.name} tiene ${n} valores que terminan en espacio; recórtalos antes.`);
      }
      const isText = new Set(columns.map((column) => column.name));
      for (const [index, cols] of await uniqueIndexes(db, table)) {
        const key = cols.map((col) => (isText.has(col) ? `${quoteName(col)} COLLATE ${TARGET}` : quoteName(col))).join(', ');
        const [[{ n }]] = await db.query(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteName(table)} GROUP BY ${key} HAVING COUNT(*) > 1) d`,
        );
        if (Number(n)) problems.push(`${table}: ${n} valores del índice único ${index} chocarían con ${TARGET}.`);
      }
    }
    return problems;
  },
  async up(db, { log }) {
    const [[{ name, collation }]] = await db.query(
      'SELECT DATABASE() AS name, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()',
    );
    if (collation !== TARGET) await db.query(`ALTER DATABASE ${quoteName(name)} CHARACTER SET utf8mb4 COLLATE ${TARGET}`);
    const tables = await pendingTables(db);
    for (const table of tables) {
      log(`  Convirtiendo ${table}…`);
      await db.query(`ALTER TABLE ${quoteName(table)} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${TARGET}`);
    }
    if (!tables.length) log('  Todas las tablas ya usan la misma collation.');
  },
};
