// Schema lookups for migrations. Table names compare as the server stores them: case-sensitively on Linux
// (lower_case_table_names = 0); Windows and macOS keep them in lower case.
const TABLE_NAME_IS = 'IF(@@lower_case_table_names = 0, BINARY TABLE_NAME = ?, TABLE_NAME = LOWER(?))';

export async function tableExists(db, name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND ${TABLE_NAME_IS} LIMIT 1`,
    [name, name],
  );
  return rows.length > 0;
}

export async function columnExists(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ${TABLE_NAME_IS} AND COLUMN_NAME = ? LIMIT 1`,
    [table, table, column],
  );
  return rows.length > 0;
}

export async function indexExists(db, table, index) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND ${TABLE_NAME_IS} AND INDEX_NAME = ? LIMIT 1`,
    [table, table, index],
  );
  return rows.length > 0;
}

export async function foreignKeyExists(db, table, name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND ${TABLE_NAME_IS}
      AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [table, table, name],
  );
  return rows.length > 0;
}

export async function lowerCaseTableNames(db) {
  const [[{ value }]] = await db.query('SELECT @@lower_case_table_names AS value');
  return Number(value);
}

export const quoteName = (name) => `\`${String(name).replace(/`/g, '``')}\``;
