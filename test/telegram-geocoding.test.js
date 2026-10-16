import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageGeocoder } from '../src/telegramGeocodingService.js';
import express from 'express';
import { createTelegramApiRouter } from '../src/telegramApiRouter.js';

test('registered antennas never initialize geocoding or call Google', async () => {
  const registered = [{ idUbicacion: 1, latitude: 29, longitude: -110 }];
  const lookup = createCoverageGeocoder({ query: async () => [registered] }, {
    initialize: async () => { throw new Error('Unexpected initialization'); },
    geocode: async () => { throw new Error('Unexpected Google request'); },
  });
  assert.deepEqual(await lookup(29, -110), { rows: registered, status: 'REGISTRADA' });
});

test('missing coordinates are geocoded once, persisted in geocoding and reused across requests', async () => {
  const saved = [];
  let googleCalls = 0;
  const lookup = createCoverageGeocoder({ query: async () => [[]] }, {
    initialize: async () => {},
    findLocation: async () => saved.length ? { address: saved[0].ubicacion, place: saved[0].lugar,
      addressDetails: saved[0].componentes_direccion, status: 'OK' } : null,
    geocode: async () => { googleCalls++; return { address: 'Calle Uno, México', place: 'Hermosillo',
      addressDetails: { street: 'Calle Uno', city: 'Hermosillo', state: 'Sonora' }, status: 'OK' }; },
    crossStreets: async () => ({ crossStreetStatus: 'RED_LOCAL_NO_CARGADA' }),
    saveLocation: async (location) => saved.push(location),
  });
  const [first, concurrent] = await Promise.all([lookup(29, -110), lookup(29, -110)]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.rows[0].ubicacion, 'Calle Uno');
  assert.equal(first.rows[0].lugar, 'Hermosillo, Sonora');
  assert.equal(first.rows[0].fuente, 'geocoding');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].latitude, 29);
  await lookup(29, -110);
  assert.equal(googleCalls, 1);
  assert.equal(saved.length, 1);
});

test('zero results are not saved and database failure does not trigger Google requests', async () => {
  const lookup = createCoverageGeocoder({ query: async () => [[]] }, {
    initialize: async () => {}, findLocation: async () => null,
    geocode: async () => ({ address: '', place: '', status: 'SIN_RESULTADOS' }),
    saveLocation: async () => { throw new Error('Unexpected save'); },
  });
  assert.deepEqual(await lookup(29, -110), { rows: [], status: 'SIN_RESULTADOS' });
  const failed = createCoverageGeocoder({ query: async () => { throw new Error('DB unavailable'); } }, {
    geocode: async () => { throw new Error('Unexpected external request'); },
  });
  await assert.rejects(failed(29, -110), /DB unavailable/);
});

test('geocoding persistence endpoint requires authorized bot identity and validates coordinates', async (t) => {
  const config = { TELEGRAM_API_TOKEN: 'x'.repeat(32), TELEGRAM_ALLOWED_USER_IDS: '123' };
  let calls = 0;
  const app = express();
  app.use('/api/bot', createTelegramApiRouter({}, config, undefined, async (lat, lng) => {
    calls++; assert.equal(lat, 29); assert.equal(lng, -110);
    return { rows: [{ ubicacion: 'Calle Uno' }], status: 'OK' };
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/bot/cobertura/ubicacion`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(calls, 0);
  const headers = { Authorization: `Bearer ${config.TELEGRAM_API_TOKEN}`, 'X-Telegram-User-Id': '123', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal(calls, 0);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ lat: '29', lng: '-110' }) });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});
