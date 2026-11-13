// Schema lookups for migrations. Table names compare case-sensitively, as MySQL does on Linux.
export async function tableExists(db, name) {
  const [rows] = await db.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ? LIMIT 1',
    [name],
  );
  return rows.length > 0;
}

export async function indexExists(db, table, index) {
  const [rows] = await db.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [table, index],
  );
  return rows.length > 0;
}

export async function lowerCaseTableNames(db) {
  const [[{ value }]] = await db.query('SELECT @@lower_case_table_names AS value');
  return Number(value);
}

export const quoteName = (name) => `\`${String(name).replace(/`/g, '``')}\``;
