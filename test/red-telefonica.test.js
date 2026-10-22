import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildNetwork, fetchFocusNetwork, searchCandidates } from '../src/redTelefonicaService.js';
import { createRedTelefonicaRouter } from '../src/redTelefonicaRouter.js';

const objective = (idObjetivo, numObjetivo, contacto) => ({ idObjetivo, numObjetivo, nuc: `NUC-${idObjetivo}`, tipo: 'Robo', ano: 2026, delito: null, contacto });

test('search candidates accept formatted numbers and also try the national 10 digits', () => {
  assert.deepEqual(searchCandidates('+52 (662) 123-4567'), ['526621234567', '6621234567']);
  assert.deepEqual(searchCandidates('6621234567'), ['6621234567']);
  assert.deepEqual(searchCandidates('123'), []);
});

test('network marks shared contacts, contacts that are objective lines and the focused number', () => {
  const rows = [
    objective(1, '6620000001', '6625550000'),
    objective(1, '6620000001', '6629999999'),
    objective(1, '6620000001', 'sin utilidad'),
    objective(2, '6620000002', '6625550000'),
    objective(2, '6620000002', '526620000001'),
  ];
  const network = buildNetwork(rows, { totals: new Map([[1, 3], [2, 2]]), focus: ['6625550000'] });
  const byId = new Map(network.nodes.map((node) => [node.id, node]));

  assert.equal(byId.get('phone:6625550000').crossings, 2);
  assert.equal(byId.get('phone:6625550000').isFocus, true);
  assert.equal(byId.get('phone:526620000001').isObjectiveLine, true);
  assert.equal(byId.get('objective:1').crossingContacts, 1);
  assert.equal(byId.get('objective:1').totalContacts, 3);
  assert.ok(!network.nodes.some((node) => node.label === 'sin utilidad'));
  assert.ok(network.links.some((link) => link.kind === 'linea' && link.source === 'objective:1' && link.target === 'phone:526620000001'));

  const crossingsOnly = buildNetwork(rows, { includeSingles: false });
  assert.ok(!crossingsOnly.nodes.some((node) => node.id === 'phone:6629999999'));
  assert.ok(crossingsOnly.nodes.some((node) => node.id === 'phone:6625550000'));
});

test('focus search reports numbers that are not in any objective', async () => {
  const pool = { query: async () => [[]] };
  assert.deepEqual(await fetchFocusNetwork(pool, '6621234567'), { nodes: [], links: [], truncated: false, found: false });
  await assert.rejects(fetchFocusNetwork(pool, '12'), { status: 400 });
});

test('network data endpoint returns the focused network and rejects invalid numbers', async (t) => {
  const pool = { query: async (sql) => {
    if (sql.includes('SELECT DISTINCT o.idObjetivo')) return [[{ idObjetivo: 1 }]];
    if (sql.includes('COUNT(*) AS total')) return [[{ idObjetivo: 1, total: 1 }]];
    return [[objective(1, '6620000001', '6625550000')]];
  } };
  const app = express();
  app.use('/red-telefonica', createRedTelefonicaRouter(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/red-telefonica/datos`;

  const response = await fetch(`${base}?numero=662-555-0000`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.found, true);
  assert.deepEqual(result.nodes.map((node) => node.id).sort(), ['objective:1', 'phone:6625550000']);

  const invalid = await fetch(`${base}?numero=12`);
  assert.equal(invalid.status, 400);
});
