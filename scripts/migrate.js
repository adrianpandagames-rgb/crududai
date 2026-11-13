// npm run migrate               applies the pending migrations
// npm run migrate -- --estado   lists them, applied or not
// npm run migrate -- --revisar  runs only the checks, changing nothing
// Take a backup first: MySQL cannot roll back a schema change.
import mysql from 'mysql2/promise';
import 'dotenv/config';
import migrations from '../migrations/index.js';
import { MigrationCheckError, migrationStatus, runMigrations } from '../src/migrationRunner.js';

const args = new Set(process.argv.slice(2));
const db = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'crudnodejs',
});

try {
  if (args.has('--estado')) {
    for (const { id, descripcion, aplicada } of await migrationStatus(db, migrations)) {
      console.log(`${aplicada ? '[aplicada] ' : '[pendiente]'} ${id} — ${descripcion}`);
    }
  } else {
    await runMigrations(db, migrations, { checkOnly: args.has('--revisar') });
  }
} catch (error) {
  console.error(error instanceof MigrationCheckError ? error.message : `Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
