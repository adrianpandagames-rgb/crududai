import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanningPoints } from '../src/planeacionService.js';
import { processRutaCsv } from '../src/rutaService.js';
import { coverageSector } from '../public/js/planeacion-geometry.js';
import express from 'express';
import { createPlaneacionRouter } from '../src/planeacionRouter.js';
import ejs from 'ejs';

test('all users see geographic planning outside Administration', async () => {
  const template = new URL('../views/includes/header.ejs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const admin = await ejs.renderFile(fileURLToPath(template), { currentUser: { isAdmin: true } });
  const user = await ejs.renderFile(fileURLToPath(template), { currentUser: { isAdmin: false } });
  assert.ok(admin.includes('href="/planeacion-geografica"'));
  assert.ok(user.includes('href="/planeacion-geografica"'));
  assert.ok(!user.includes('<summary class="menu-item">Administración</summary>'));
});

test('planning upload is available to all authenticated users and returns enriched map data', async (t) => {
  const app = express();
  let queries = 0;
  app.use((req, res, next) => {
    req.session = { userId: 1, isAdmin: req.headers['x-test-admin'] === 'yes', role: 'usuario' };
    next();
  });
  app.use('/planeacion-geografica', createPlaneacionRouter({ query: async () => {
    queries++;
    return [[{ idUbicacion: 'ABC', latitude: 29.1, longitude: -110.9, ubicacion: 'Centro', lugar: 'Hermosillo' }]];
  } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/planeacion-geografica/importar`;
  for (const headers of [{}, { 'x-test-admin': 'yes' }]) {
    const body = new FormData();
    body.append('linea', '123');
    body.append('archivo', new Blob(['antena,azimuth\nABC,50\n'], { type: 'text/csv' }), 'antenas.csv');
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const result = await response.json();
    assert.equal(result.line, '123');
    assert.deepEqual(result.points, [{ lat: 29.1, lng: -110.9, azimuth: 50, row: 1 }]);
    assert.ok(result.csv.includes('Hermosillo'));
  }
  assert.equal(queries, 2);
  const emptyBody = new FormData();
  emptyBody.append('linea', '123');
  const invalid = await fetch(url, { method: 'POST', headers: { 'x-test-admin': 'yes' }, body: emptyBody });
  assert.equal(invalid.status, 400);
});

test('planning uses Ruta enrichment and preserves original information and per-row azimuth', () => {
  const rows = processRutaCsv('antena,fecha,azimuth\nABC,13/10/2026,50\n', [
    { idUbicacion: 'ABC', latitude: 29.1, longitude: -110.9, ubicacion: 'Centro', lugar: 'Hermosillo' },
  ]);
  assert.equal(rows[1][1], '13/10/2026');
  assert.equal(rows[1][rows[0].indexOf('ubicacion')], 'Centro');
  assert.deepEqual(extractPlanningPoints(rows), {
    points: [{ lat: 29.1, lng: -110.9, azimuth: 50, row: 1 }], omitted: 0, missingAzimuth: 0,
  });
});

test('blank or invalid coordinates are omitted instead of plotting at zero, zero', () => {
  const rows = [['latitud', 'longitud', 'azimut'], ['', '', '50'], ['91', '0', '50'],
    ['0', '0', '0'], ['29', '-110', ''], ['29', '-110', '410']];
  const result = extractPlanningPoints(rows);
  assert.equal(result.omitted, 2);
  assert.equal(result.missingAzimuth, 1);
  assert.deepEqual(result.points.map((point) => point.azimuth), [0, null, 50]);
});

test('semicolon decimal coordinates and degree suffixes are accepted', () => {
  const rows = [['latitud', 'longitud', 'AZIMUT'], ['29,1', '-110,9', '50°']];
  rows.delimiter = ';';
  assert.deepEqual(extractPlanningPoints(rows).points[0], { lat: 29.1, lng: -110.9, azimuth: 50, row: 1 });
});

test('coverage at azimuth 50 has bounds 5 and 95 degrees and geodesic radius 500m', () => {
  const lat = 29.1, lng = -110.9;
  const sector = coverageSector(lat, lng, 50, 500);
  const rad = Math.PI / 180;
  for (const [phi, lambda] of sector.slice(1, -1)) {
    const dPhi = (phi - lat) * rad, dLambda = (lambda - lng) * rad;
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(lat * rad) * Math.cos(phi * rad) * Math.sin(dLambda / 2) ** 2;
    assert.ok(Math.abs(6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) - 500) < 0.001);
  }
  function bearing([phi, lambda]) {
    const delta = (lambda - lng) * rad;
    return (Math.atan2(Math.sin(delta) * Math.cos(phi * rad), Math.cos(lat * rad) * Math.sin(phi * rad) - Math.sin(lat * rad) * Math.cos(phi * rad) * Math.cos(delta)) / rad + 360) % 360;
  }
  assert.ok(Math.abs(bearing(sector[1]) - 5) < 0.00001);
  assert.ok(Math.abs(bearing(sector.at(-2)) - 95) < 0.00001);
  assert.deepEqual(sector[0], sector.at(-1));
});
