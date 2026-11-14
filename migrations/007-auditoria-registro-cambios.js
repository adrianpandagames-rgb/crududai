import { columnExists, tableExists } from './helpers.js';

// The audit log names the record each action touched and, for edits and deletions, the values before and
// after, as plain text ("Campo: antes → después", one per line) that reads the same in the page, the CSV
// and the database.
export default {
  id: '007-auditoria-registro-cambios',
  descripcion: 'Agrega a audit_logs el registro afectado y los cambios (antes → después) en texto plano.',
  async check(db) {
    return await tableExists(db, 'audit_logs') ? [] : ['no existe la tabla audit_logs (npm run migrate:audit-logs).'];
  },
  async up(db, { log }) {
    if (!await columnExists(db, 'audit_logs', 'registro')) {
      await db.query('ALTER TABLE audit_logs ADD COLUMN registro VARCHAR(255) NULL AFTER status_code');
      log('  audit_logs.registro agregada.');
    }
    if (!await columnExists(db, 'audit_logs', 'cambios')) {
      await db.query('ALTER TABLE audit_logs ADD COLUMN cambios TEXT NULL AFTER registro');
      log('  audit_logs.cambios agregada.');
    }
  },
};
