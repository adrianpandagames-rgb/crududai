import test from 'node:test';
import assert from 'node:assert/strict';
import { findCrossStreets, createCrossStreetLookup } from '../src/entrecallesService.js';
import { processGeocodingFile, readGeocodingFile } from '../src/georeferenciacionService.js';

const node = (id, lat, lon) => ({ type: 'node', id, lat, lon });
const way = (id, name, nodes) => ({ type: 'way', id, tags: { highway: 'residential', name }, nodes });
const network = [node(1, 0, -.002), node(2, 0, -.001), node(3, 0, .001), node(4, 0, .002),
  node(5, -.001, -.002), node(6, .001, -.002), node(7, -.001, .002), node(8, .001, .002),
  way(10, 'Juárez', [1, 2]), way(11, 'Juárez', [2, 3, 4]),
  way(12, 'Hidalgo', [5, 1, 6]), way(13, 'Morelos', [7, 4, 8])];

test('finds both block ends across split ways and intermediate geometry nodes', () => {
  assert.deepEqual(findCrossStreets(network, 0, 0, 'JUAREZ'), {
    betweenStreet1: 'Hidalgo', betweenStreet2: 'Morelos', crossStreetStatus: 'ENCONTRADAS',
  });
});

test('selects the nearest perpendicular intersections for horizontal and vertical main streets', () => {
  const withDiagonal = [...network, node(9, .0005, -.001), way(14, 'Diagonal', [1, 9])];
  for (const elements of [
    withDiagonal,
    withDiagonal.map((element) => element.type === 'node'
      ? { ...element, lat: element.lon, lon: element.lat }
      : element),
  ]) {
    assert.deepEqual(findCrossStreets(elements, 0, 0, 'Juárez'), {
      betweenStreet1: 'Hidalgo', betweenStreet2: 'Morelos', crossStreetStatus: 'ENCONTRADAS',
    });
  }
});

test('preserves all named roads at an ambiguous block end instead of erasing both entrecalles', () => {
  const data = [...network, node(9, .001, -.002), way(14, 'Otra calle', [1, 9])];
  assert.deepEqual(findCrossStreets(data, 0, 0, 'Juárez'), {
    betweenStreet1: 'Hidalgo / Otra calle', betweenStreet2: 'Morelos', crossStreetStatus: 'REQUIERE_REVISION',
  });
  const incomplete = network.filter((e) => e.id !== 13);
  assert.deepEqual(findCrossStreets(incomplete, 0, 0, 'Juárez'), {
    betweenStreet1: 'Hidalgo', betweenStreet2: '', crossStreetStatus: 'REQUIERE_REVISION',
  });
});

test('requires review for corners, missing connections, distant points, unnamed intersections and branches', () => {
  for (const [data, lat, lon, street] of [
    [network, 0, -.002, 'Juárez'], [network.filter((e) => e.id !== 13), 0, 0, 'Juárez'],
    [network, .002, 0, 'Juárez'], [network, 0, 0, 'Otra calle'],
    [[...network, node(9, .001, .001), way(14, '', [3, 9])], 0, 0, 'Juárez'],
    [[...network, node(9, .001, .001), way(14, 'Juárez', [3, 9])], 0, 0, 'Juárez'],
  ]) assert.equal(findCrossStreets(data, lat, lon, street).crossStreetStatus, 'REQUIERE_REVISION');
});

test('reuses nearby road data and does not retry an unavailable provider for every row', async () => {
  let calls = 0;
  const lookup = createCrossStreetLookup({ fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.method, 'POST');
    assert.ok(options.body.get('data').includes('out body'));
    return { ok: true, json: async () => ({ elements: network }) };
  } });
  assert.equal((await lookup(0, 0, { street: 'Juárez' })).crossStreetStatus, 'ENCONTRADAS');
  await lookup(0, .0001, { street: 'Juárez' });
  assert.equal(calls, 1);
  const unavailable = createCrossStreetLookup({ fallback: '', onError: () => {}, fetchImpl: async () => { calls++; throw new Error('offline'); } });
  assert.equal((await unavailable(0, 0, { street: 'Juárez' })).crossStreetStatus, 'SERVICIO_NO_DISPONIBLE');
  await unavailable(1, 1, { street: 'Juárez' });
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lookup(0, 0, { signal: controller.signal }), /cancelado/);
});

test('fails over after HTTP errors, identifies requests and keeps using the healthy provider', async () => {
  const calls = [], errors = [];
  const lookup = createCrossStreetLookup({ endpoint: 'https://primary.test/api', fallback: 'https://backup.test/api',
    sleep: async () => {}, onError: (error) => errors.push(error), fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(options.headers['User-Agent'].includes('CRUD-UDAI'));
      if (url.includes('primary')) return { ok: false, status: 504 };
      return { ok: true, json: async () => ({ elements: network }) };
    } });
  assert.equal((await lookup(0, 0, { street: 'Juárez' })).crossStreetStatus, 'ENCONTRADAS');
  await lookup(1, 1, { street: 'Juárez' });
  assert.deepEqual(calls, ['https://primary.test/api', 'https://backup.test/api', 'https://backup.test/api']);
  assert.deepEqual(errors, [{ provider: 'primary.test', reason: 'HTTP_504' }]);
});

test('recovers after cooldown and still serves cached locations during outages', async () => {
  let clock = 100000, available = true, calls = 0;
  const lookup = createCrossStreetLookup({ fallback: '', now: () => clock, sleep: async () => {}, onError: () => {},
    fetchImpl: async () => { calls++; return available ? { ok: true, json: async () => ({ elements: network }) } : { ok: false, status: 429 }; } });
  await lookup(0, 0, { street: 'Juárez' });
  available = false;
  assert.equal((await lookup(1, 1, { street: 'Juárez' })).crossStreetStatus, 'SERVICIO_NO_DISPONIBLE');
  assert.equal((await lookup(0, 0, { street: 'Juárez' })).crossStreetStatus, 'ENCONTRADAS');
  await lookup(2, 2, { street: 'Juárez' });
  assert.equal(calls, 2);
  clock += 60001;
  available = true;
  await lookup(2, 2, { street: 'Juárez' });
  assert.equal(calls, 3);
});

test('exports and persists entrecalles once per coordinate without losing Google results', async () => {
  const input = readGeocodingFile(Buffer.from('lat,lon\n0,0\n0,0'), '.csv');
  const saved = [];
  let calls = 0;
  const rows = await processGeocodingFile(input, {
    geocode: async () => ({ status: 'OK', address: 'Juárez 123', street: 'Juárez', place: 'Ciudad' }),
    crossStreets: async () => { calls++; return findCrossStreets(network, 0, 0, 'Juárez'); },
    onLocation: async (location) => saved.push(location),
  });
  assert.equal(calls, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entre_calle_1, 'Hidalgo');
  assert.equal(rows[1][rows[0].indexOf('entre_calle_2')], 'Morelos');
  assert.equal(rows[2][rows[0].indexOf('estado_entrecalles')], 'ENCONTRADAS');
  assert.ok(rows[1][rows[0].indexOf('fuente_entrecalles')].includes('openstreetmap.org/copyright'));
});
