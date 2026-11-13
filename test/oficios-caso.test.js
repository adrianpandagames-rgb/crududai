import test from 'node:test';
import assert from 'node:assert/strict';
import { conAnoNuc, enlazarOficio, enTransaccion, insertarAnoNuc, validarAnoNuc } from '../src/oficiosCaso.js';

const hoy = new Date('2026-11-13T12:00:00Z');

test('the NUC year is a four-digit year from 2000 to next year', () => {
  assert.equal(validarAnoNuc('2026', hoy), 2026);
  assert.equal(validarAnoNuc(' 2027 ', hoy), 2027);
  assert.equal(validarAnoNuc(2000, hoy), 2000);
  for (const malo of ['', '26', '1999', '2028', '20a6', null, undefined, ['2026']]) {
    assert.throws(() => validarAnoNuc(malo, hoy), /Año del NUC/);
  }
});

test('a wrapped validator keeps its result and adds the year', () => {
  const validar = conAnoNuc((body) => ({ nuc: body.nuc }));
  assert.equal(validar({ nuc: '123', ano: String(new Date().getFullYear()) }).nuc, '123');
  assert.throws(() => validar({ nuc: '123' }), /Año del NUC/);
});

test('the year field goes right after the NUC, required in every form shape', () => {
  assert.deepEqual(insertarAnoNuc([['nuc', 'NUC', 'text'], ['x', 'X', 'text']]).map(([n]) => n), ['nuc', 'ano', 'x']);
  // Datos Conservados carries an "optional" flag as fourth entry; the year gets false (required).
  assert.deepEqual(insertarAnoNuc([['nuc', 'NUC', 'text', false]])[1], ['ano', 'Año del NUC', 'number', false]);
  assert.deepEqual(insertarAnoNuc([['x', 'X', 'text']]).map(([n]) => n), ['x']);
});

const fakeDb = () => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.startsWith('INSERT INTO casos')) return [{ insertId: 7 }];
      if (sql.startsWith('INSERT INTO delitos')) return [{ insertId: 3 }];
      if (sql.startsWith('SELECT nombre FROM delitos')) return [[{ nombre: 'Robo de vehículo' }]];
      throw new Error(sql);
    },
    execute: async (sql, params) => { calls.push([sql, params]); return [{ affectedRows: 1 }]; },
  };
};

test('a record points to its case and catalog delito', async () => {
  const db = fakeDb();
  await enlazarOficio(db, 'Inspecciones', 5, { nuc: ' 123 ', ano: 2026, delito: 'robo  de vehiculo' });
  const [sql, params] = db.calls.at(-1);
  assert.match(sql, /UPDATE Inspecciones SET ano = \?, caso_id = \?, delito = \?, delito_id = \? WHERE id = \?/);
  assert.deepEqual(params, [2026, 7, 'Robo de vehículo', 3, 5]);
});

test('Recepciones has no delito, so only the case is linked', async () => {
  const db = fakeDb();
  await enlazarOficio(db, 'Recepciones', 9, { nuc: '123', ano: 2025 });
  assert.ok(!db.calls.some(([sql]) => sql.includes('delitos')));
  assert.deepEqual(db.calls.at(-1), ['UPDATE Recepciones SET ano = ?, caso_id = ? WHERE id = ?', [2025, 7, 9]]);
});

test('a transaction commits on success and rolls back on failure, releasing the connection', async () => {
  const log = [];
  const connection = {
    beginTransaction: async () => log.push('begin'), commit: async () => log.push('commit'),
    rollback: async () => log.push('rollback'), release: () => log.push('release'),
  };
  const pool = { getConnection: async () => connection };
  assert.equal(await enTransaccion(pool, async (db) => { assert.equal(db, connection); return 1; }), 1);
  assert.deepEqual(log.splice(0), ['begin', 'commit', 'release']);
  await assert.rejects(enTransaccion(pool, async () => { throw new Error('falla'); }), /falla/);
  assert.deepEqual(log, ['begin', 'rollback', 'release']);
});
