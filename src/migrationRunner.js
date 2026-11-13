// Versioned schema changes. Each migration runs once, in order, and is recorded in schema_migrations.
// MySQL commits every DDL statement on its own, so a migration cannot be rolled back halfway: each one checks the
// current schema before every step (`up` can run again after a failure), and every pending migration's `check`
// runs before anything changes, so a problem found in the data stops the whole run untouched.
export const MIGRATIONS_TABLE = 'schema_migrations';
const LOCK_NAME = 'crududai_schema_migrations';

const ensureTable = (db) => db.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id VARCHAR(100) NOT NULL PRIMARY KEY,
  descripcion VARCHAR(255) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

const appliedIds = async (db) => {
  const [rows] = await db.query(`SELECT id FROM ${MIGRATIONS_TABLE}`);
  return new Set(rows.map((row) => row.id));
};

const validate = (migrations) => {
  const ids = new Set();
  for (const migration of migrations) {
    if (!migration.id || !migration.descripcion || typeof migration.up !== 'function') {
      throw new Error(`Migración inválida: ${migration.id || '(sin id)'}`);
    }
    if (ids.has(migration.id)) throw new Error(`Migración repetida: ${migration.id}`);
    ids.add(migration.id);
  }
};

export class MigrationCheckError extends Error {
  constructor(problems) {
    super(`No se aplicó ninguna migración:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.problems = problems;
  }
}

export async function migrationStatus(db, migrations) {
  validate(migrations);
  await ensureTable(db);
  const applied = await appliedIds(db);
  return migrations.map(({ id, descripcion }) => ({ id, descripcion, aplicada: applied.has(id) }));
}

const runCheck = async (db, migration) => (await migration.check?.(db) || []).map((problem) => `${migration.id}: ${problem}`);

// `db` must be a single connection, not a pool: the lock that keeps two runs apart belongs to the connection.
export async function runMigrations(db, migrations, { log = console.log, checkOnly = false } = {}) {
  validate(migrations);
  await ensureTable(db);
  const [[{ locked }]] = await db.query('SELECT GET_LOCK(?, 0) AS locked', [LOCK_NAME]);
  if (Number(locked) !== 1) throw new Error('Otra ejecución de migraciones está en curso.');
  try {
    const applied = await appliedIds(db);
    const pending = migrations.filter((migration) => !applied.has(migration.id));
    if (!pending.length) {
      log('No hay migraciones pendientes.');
      return [];
    }
    const problems = [];
    for (const migration of pending) problems.push(...await runCheck(db, migration));
    if (problems.length) throw new MigrationCheckError(problems);
    if (checkOnly) {
      log(`Revisión correcta. Pendientes: ${pending.map((migration) => migration.id).join(', ')}`);
      return [];
    }
    const done = [];
    for (const migration of pending) {
      // Checked again right before, since an earlier migration of this run may have changed what it looks at.
      const late = await runCheck(db, migration);
      if (late.length) throw new MigrationCheckError(late);
      log(`Aplicando ${migration.id}: ${migration.descripcion}`);
      await migration.up(db, { log });
      await db.query(`INSERT INTO ${MIGRATIONS_TABLE} (id, descripcion) VALUES (?, ?)`, [migration.id, migration.descripcion]);
      done.push(migration.id);
    }
    log(`Listo. Aplicadas: ${done.join(', ')}`);
    return done;
  } finally {
    await db.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
  }
}
