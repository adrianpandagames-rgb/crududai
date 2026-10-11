import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCrossStreetLookup, inferLocalStreet } from '../src/redVialLocal.js';
import { processGeocodingFile, readGeocodingFile } from '../src/georeferenciacionService.js';

const network = [
  { type: 'node', id: 1, lat: 0, lon: -.002 }, { type: 'node', id: 2, lat: 0, lon: .002 },
  { type: 'node', id: 3, lat: -.001, lon: -.002 }, { type: 'node', id: 4, lat: .001, lon: .002 },
  { type: 'way', id: 10, nodes: [1, 2], tags: { name: 'Juárez', highway: 'residential' } },
  { type: 'way', id: 11, nodes: [1, 3], tags: { name: 'Hidalgo', highway: 'residential' } },
  { type: 'way', id: 12, nodes: [2, 4], tags: { name: 'Morelos', highway: 'residential' } },
];

test('local lookup reads active dataset, deduplicates nodes and caches nearby queries', async () => {
  const calls = [];
  const pool = { execute: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('version')) return [[{ dataset: 'active', road_count: 3 }]];
    assert.equal(values[0], 'active');
    return [[{ elements: JSON.stringify(network) }, { elements: network }]];
  } };
  const lookup = createLocalCrossStreetLookup(pool);
  const first = await lookup(0, 0, { street: 'Juárez' });
  assert.equal(first.crossStreetStatus, 'ENCONTRADAS');
  assert.equal(first.betweenStreet1, 'Hidalgo');
  assert.equal((await lookup(0, .0001)).betweenStreet2, 'Morelos');
  assert.equal(calls.length, 2);
  assert.equal(inferLocalStreet(network, 0, 0), 'Juárez');
  assert.equal(inferLocalStreet(network, .01, 0), '');
  assert.equal(inferLocalStreet(network, 0, -.002), '');
});

test('local lookup falls back to the nearest street when the Google street is absent from the road dataset', async () => {
  const lookup = createLocalCrossStreetLookup({ execute: async (sql) => sql.includes('version')
    ? [[{ dataset: 'active' }]] : [[{ elements: network }]] });
  const result = await lookup(0, 0, { street: 'Nombre distinto de Google' });
  assert.deepEqual(result, {
    betweenStreet1: 'Hidalgo',
    betweenStreet2: 'Morelos',
    crossStreetStatus: 'ENCONTRADAS',
  });
});

test('missing local dataset requires import without requesting external data', async () => {
  const lookup = createLocalCrossStreetLookup({ execute: async () => [[]] });
  assert.equal((await lookup(29, -110)).crossStreetStatus, 'RED_LOCAL_NO_CARGADA');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lookup(29, -110, { signal: controller.signal }), /cancelado/);
});

test('cached Google address gets pending entrecalles locally without new Google requests', async () => {
  let stored;
  const rows = await processGeocodingFile(readGeocodingFile(Buffer.from('lat,lon\n0,0\n0,0'), '.csv'), {
    findLocation: async () => ({ address: 'Guardada', place: 'Ciudad', status: 'OK', crossStreetStatus: 'SERVICIO_NO_DISPONIBLE' }),
    refreshStoredCrossStreets: true,
    crossStreets: createLocalCrossStreetLookup({ execute: async (sql) => sql.includes('version') ? [[{ dataset: 'active' }]] : [[{ elements: network }]] }),
    geocode: async () => assert.fail('Must reuse saved Google address'),
    onLocation: async (location) => { assert.equal(stored, undefined); stored = location; },
  });
  assert.equal(stored.ubicacion, 'Guardada');
  assert.equal(stored.entre_calle_2, 'Morelos');
  assert.equal(rows[1][rows[0].indexOf('estado_entrecalles')], 'ENCONTRADAS');
});
