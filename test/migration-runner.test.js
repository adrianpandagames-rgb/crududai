import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationCheckError, migrationStatus, runMigrations } from '../src/migrationRunner.js';
import migrations from '../migrations/index.js';

// Only the statements the runner itself sends; a migration's own SQL goes through its fake `up`.
const fakeDb = ({ applied = [], lockFree = true } = {}) => {
  const state = { applied: [...applied], locks: 0, released: 0 };
  state.query = async (sql, params = []) => {
    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return [[]];
    if (/GET_LOCK/.test(sql)) { state.locks += 1; return [[{ locked: lockFree ? 1 : 0 }]]; }
    if (/RELEASE_LOCK/.test(sql)) { state.released += 1; return [[]]; }
    if (/^SELECT id FROM schema_migrations/.test(sql)) return [state.applied.map((id) => ({ id }))];
    if (/^INSERT INTO schema_migrations/.test(sql)) { state.applied.push(params[0]); return [[]]; }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  return state;
};
const migration = (id, calls, { problems = [] } = {}) => ({
  id, descripcion: `migración ${id}`, check: async () => problems, up: async () => { calls.push(id); },
});
const quiet = { log: () => {} };

test('pending migrations run in order, once, and are recorded', async () => {
  const db = fakeDb({ applied: ['001'] });
  const calls = [];
  const list = [migration('001', calls), migration('002', calls), migration('003', calls)];
  assert.deepEqual(await runMigrations(db, list, quiet), ['002', '003']);
  assert.deepEqual(calls, ['002', '003']);
  assert.deepEqual(db.applied, ['001', '002', '003']);
  assert.deepEqual(await runMigrations(db, list, quiet), []);
  assert.deepEqual(calls, ['002', '003']);
  assert.equal(db.released, db.locks);
});

test('a problem in any pending check stops the run before any change', async () => {
  const db = fakeDb();
  const calls = [];
  const list = [migration('001', calls), migration('002', calls, { problems: ['datos repetidos'] })];
  await assert.rejects(runMigrations(db, list, quiet), (error) => error instanceof MigrationCheckError && /002: datos repetidos/.test(error.message));
  assert.deepEqual(calls, []);
  assert.deepEqual(db.applied, []);
  assert.equal(db.released, 1);
});

test('check-only mode changes nothing', async () => {
  const db = fakeDb();
  const calls = [];
  await runMigrations(db, [migration('001', calls)], { ...quiet, checkOnly: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(db.applied, []);
});

test('a failed migration stays pending and the later ones do not run', async () => {
  const db = fakeDb();
  const calls = [];
  const failing = { id: '002', descripcion: 'falla', up: async () => { throw new Error('boom'); } };
  await assert.rejects(runMigrations(db, [migration('001', calls), failing, migration('003', calls)], quiet), /boom/);
  assert.deepEqual(db.applied, ['001']);
  assert.deepEqual(calls, ['001']);
  assert.equal(db.released, 1);
});

test('a second run at the same time is refused', async () => {
  const db = fakeDb({ lockFree: false });
  await assert.rejects(runMigrations(db, [migration('001', [])], quiet), /en curso/);
  // The lock belongs to the other run, so this one does not release it.
  assert.equal(db.released, 0);
});

test('status lists every migration as applied or pending', async () => {
  const db = fakeDb({ applied: ['001'] });
  assert.deepEqual((await migrationStatus(db, [migration('001', []), migration('002', [])])).map((m) => m.aplicada), [true, false]);
});

test('the project list is valid: unique ids in numeric order', () => {
  const ids = migrations.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  for (const m of migrations) assert.equal(typeof m.up, 'function');
});
