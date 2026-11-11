import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildSites, parseCells, estimateRange, distance, SETTINGS, OPERATORS } from '../src/alcanceService.js';
import { destination } from '../public/js/planeacion-geometry.js';
import { createPlaneacionRouter } from '../src/planeacionRouter.js';

// Invented antenna and neighbours; no real case data.
const origin = [20, -100];
const at = (bearing, metres, mnc = 20, samples = 10) => {
  const [lat, lng] = destination(origin[0], origin[1], bearing, metres);
  return { mnc, lat, lng, samples };
};

test('parseCells keeps well-measured rows and skips the header', () => {
  const text = [
    'radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal',
    'LTE,334,20,1,1,0,-100.0,20.0,1000,5,1,0,0,0',
    'LTE,334,20,1,2,0,-100.1,20.1,1000,1,1,0,0,0',
    'GSM,334,50,1,3,0,abc,20.1,1000,9,1,0,0,0',
  ].join('\n');
  assert.deepEqual(parseCells(text), [{ mnc: 20, lat: 20, lng: -100, samples: 5 }]);
});

test('buildSites merges scattered cells of one tower but not of different operators', () => {
  const { sites } = buildSites([at(0, 0), at(90, 200), at(180, 300), at(0, 0, 50), at(0, 3000)]);
  assert.equal(sites.filter((site) => site.mnc === 20).length, 2);
  assert.equal(sites.filter((site) => site.mnc === 50).length, 1);
});

test('the sector reaches 0.6 of the nearest neighbour ahead and ignores those behind', () => {
  const sites = buildSites([at(0, 0), at(10, 2000), at(180, 900)]);
  const ahead = estimateRange(sites, { lat: origin[0], lng: origin[1], azimuth: 0 }, [20]);
  assert.equal(ahead.method, 'vecinos');
  assert.ok(Math.abs(ahead.neighbour - 2000) < 5);
  assert.equal(ahead.range, Math.round(ahead.neighbour * SETTINGS.factor));
  // Without azimuth every direction counts, so the closer site behind decides.
  const around = estimateRange(sites, { lat: origin[0], lng: origin[1], azimuth: null }, [20]);
  assert.ok(Math.abs(around.neighbour - 900) < 5);
});

test('the antenna itself, other operators and empty areas do not shrink the sector', () => {
  const sites = buildSites([at(0, 400), at(0, 1500, 50)]);
  const nothingAhead = estimateRange(sites, { lat: origin[0], lng: origin[1], azimuth: 0 }, [20]);
  assert.deepEqual(nothingAhead, { range: SETTINGS.noNeighbourRange, method: 'sin-datos' });
  const allOperators = estimateRange(sites, { lat: origin[0], lng: origin[1], azimuth: 0 }, OPERATORS.todos.mnc);
  assert.equal(allOperators.range, 900);
  const behindOnly = estimateRange(buildSites([at(180, 2000)]), { lat: origin[0], lng: origin[1], azimuth: 0 }, [20]);
  assert.equal(behindOnly.method, 'sin-vecinos-sector');
});

test('ranges stay within the configured limits', () => {
  const far = estimateRange(buildSites([at(0, 14000)]), { lat: origin[0], lng: origin[1], azimuth: 0 }, [20]);
  assert.equal(far.range, 8400);
  const near = estimateRange(buildSites([at(0, 610)]), { lat: origin[0], lng: origin[1], azimuth: 0 }, [20]);
  assert.equal(near.range, 366);
  assert.ok(Math.abs(distance(...origin, ...destination(...origin, 45, 1234)) - 1234) < 0.5);
});

test('POST /alcance validates input and answers per antenna', async (t) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
  let available = true;
  const index = buildSites([at(0, 0), at(0, 2000)]);
  app.use('/planeacion-geografica', createPlaneacionRouter({ query: async () => [[]] }, {
    sites: async () => { if (!available) throw new Error('missing'); return index; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/planeacion-geografica/alcance`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const antenna = { lat: origin[0], lng: origin[1], azimuth: 0 };

  const ok = await post({ operador: 'telcel', antenas: [antenna, { ...antenna, azimuth: null }] });
  assert.equal(ok.status, 200);
  const result = await ok.json();
  assert.equal(result.operador, 'Telcel');
  assert.equal(result.alcances.length, 2);
  assert.equal(result.alcances[0].method, 'vecinos');

  assert.equal((await post({ operador: 'toString', antenas: [antenna] })).status, 400);
  assert.equal((await post({ operador: 'telcel', antenas: [] })).status, 400);
  assert.equal((await post({ operador: 'telcel', antenas: [{ lat: 'x', lng: 1, azimuth: 0 }] })).status, 400);
  available = false;
  assert.equal((await post({ operador: 'telcel', antenas: [antenna] })).status, 503);
});
