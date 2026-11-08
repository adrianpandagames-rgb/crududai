import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTablasStore, normalizarConfigTabla, tablaValida } from '../src/tablasService.js';
import { createCuentaRouter } from '../src/cuentaRouter.js';
import { auditRequestAction } from '../src/auditMiddleware.js';

test('a table layout keeps only clean values and is empty when it matches the default', () => {
  assert.deepEqual(normalizarConfigTabla({
    orden: ['nuc', 'objetivo', 'nuc', '<script>', 'x'.repeat(41)],
    anchos: { nuc: 10, objetivo: '250.4', tipo: 99999, 'mal id': 100, accion: 'ancho' },
    fijas: ['objetivo', 7],
    densidad: 'compacta',
  }), { orden: ['nuc', 'objetivo'], anchos: { nuc: 48, objetivo: 250, tipo: 1200 }, fijas: ['objetivo'], densidad: 'compacta' });
  assert.equal(normalizarConfigTabla({ orden: [], anchos: {}, fijas: [], densidad: 'normal' }), null);
  assert.equal(normalizarConfigTabla({ densidad: 'gigante' }), null);
  assert.equal(normalizarConfigTabla('no es json'), null);
  assert.equal(normalizarConfigTabla(['nuc']), null);
  assert.equal(normalizarConfigTabla(null), null);
  assert.deepEqual(normalizarConfigTabla('{"fijas":["nuc"]}').fijas, ['nuc']);
  assert.ok(tablaValida('lineas-resultados'));
  assert.ok(!tablaValida('../otra'));
  assert.ok(!tablaValida(''));
});

test('the store saves per person and a default layout deletes the row', async () => {
  const calls = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      calls.push([sql.trim().split(/\s+/)[0], values]);
      if (sql.startsWith('SELECT')) return [[{ tabla: 'ruta-archivos', config: '{"densidad":"amplia"}' }, { tabla: 'vieja', config: 'roto' }]];
      return [{ affectedRows: 1 }];
    },
  };
  const store = createTablasStore(pool);
  assert.deepEqual(await store.listar(5), { 'ruta-archivos': { orden: [], anchos: {}, fijas: [], densidad: 'amplia' } });
  await store.guardar(5, 'ruta-archivos', { orden: [], anchos: {}, fijas: ['archivo'], densidad: 'normal' });
  await store.guardar(5, 'ruta-archivos', null);
  assert.deepEqual(calls.map(([verb, values]) => [verb, values[0], values[1]]),
    [['SELECT', 5, undefined], ['INSERT', 5, 'ruta-archivos'], ['DELETE', 5, 'ruta-archivos']]);
});

test('Mi cuenta reads and saves only the signed-in person\'s tables, and it is not audited', async (t) => {
  const saved = [];
  const tablas = {
    listar: async (userId) => ({ owner: { orden: [], anchos: {}, fijas: [String(userId)], densidad: 'normal' } }),
    guardar: async (userId, tabla, config) => saved.push([userId, tabla, config]),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 5, role: 'usuario' }; next(); });
  app.use('/cuenta', createCuentaRouter(null, { cuentas: {}, notificaciones: {}, tablas }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/cuenta/tablas`;
  const put = (body) => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.deepEqual(await (await fetch(base)).json(), { owner: { orden: [], anchos: {}, fijas: ['5'], densidad: 'normal' } });
  assert.equal((await put({ tabla: 'auditoria', userId: 9, config: { densidad: 'compacta', extra: 1 } })).status, 204);
  assert.equal((await put({ tabla: 'auditoria', config: null })).status, 204);
  assert.equal((await put({ tabla: '../x', config: {} })).status, 400);
  assert.deepEqual(saved, [
    [5, 'auditoria', { orden: [], anchos: {}, fijas: [], densidad: 'compacta' }],
    [5, 'auditoria', null],
  ]);

  assert.equal(auditRequestAction({ method: 'PUT', originalUrl: '/cuenta/tablas', query: {} }), null);
  assert.equal(auditRequestAction({ method: 'GET', originalUrl: '/cuenta/tablas', query: {} }), null);
});
