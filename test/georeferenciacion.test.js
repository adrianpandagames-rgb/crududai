import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import ejs from 'ejs';
import express from 'express';
import { createGeoreferenciacionRouter } from '../src/georeferenciacionRouter.js';
import { saveGeocodingLocation, findGeocodingLocation } from '../src/georeferenciacionUbicaciones.js';
import { readGeocodingFile, processGeocodingFile, reverseGeocode } from '../src/georeferenciacionService.js';
import { createRutaCsv, createRutaXlsx, processRutaXlsx } from '../src/rutaService.js';

test('geocoding preserves rows, deduplicates coordinates and skips missing or invalid coordinates', async () => {
  const input = readGeocodingFile(Buffer.from('fecha,latitud,longitud,extra\n01/01/2026,29,-110,A\n02/01/2026,29,-110,B\n03/01/2026,,-110,C\n04/01/2026,91,-110,D\n05/01/2026,0,0,E'), '.csv');
  const calls = [];
  const rows = await processGeocodingFile(input, { geocode: async (lat, lng) => {
    calls.push([lat, lng]);
    return lat === 0 ? { address: '', place: '', status: 'SIN_RESULTADOS' } : { address: 'Calle 1, Sonora', place: 'Hermosillo', status: 'OK' };
  } });
  assert.deepEqual(calls, [[29, -110], [0, 0]]);
  assert.equal(rows[1][3], 'A');
  assert.equal(rows[2][4], rows[1][4]);
  assert.equal(rows[1][5], 'Calle 1, Sonora');
  assert.equal(rows[3].at(-1), 'COORDENADAS_INVALIDAS');
  assert.equal(rows[4].at(-1), 'COORDENADAS_INVALIDAS');
  assert.equal(rows[5].at(-1), 'SIN_RESULTADOS');
  const book = XLSX.read(createRutaXlsx(createRutaCsv(rows)), { type: 'buffer' });
  assert.equal(book.Sheets.Ruta.F2.v, 'Calle 1, Sonora');
});

test('semicolon decimal commas, DMS and XLSX input are supported', async () => {
  const input = readGeocodingFile(Buffer.from('latitud;longitud\n29,5;-110,5\n29°30\'0N;110°30\'0W'), '.csv');
  let calls = 0;
  const rows = await processGeocodingFile(input, { geocode: async (lat, lng) => {
    calls++;
    assert.equal(lat, 29.5);
    assert.equal(lng, -110.5);
    return { address: 'Dirección', place: 'Ciudad', status: 'OK' };
  } });
  assert.equal(calls, 1);
  assert.equal(rows.delimiter, ';');
  const buffer = createRutaXlsx('fecha,latitud,longitud\n01/01/2026,29,-110\n');
  assert.equal(readGeocodingFile(buffer, '.xlsx').rows[1][0], '01/01/2026');
  assert.equal(processRutaXlsx(buffer, [{ latitude: 29, longitude: -110, ubicacion: 'Original', lugar: 'Ciudad' }])[1][4], 'Original');
  assert.throws(() => readGeocodingFile(Buffer.from('antena\n1'), '.csv'), /latitud y longitud/);
});

test('Google request uses latlng and Spanish; address components are selected by type', async () => {
  const result = await reverseGeocode(29, -110, { apiKey: 'test-key', fetchImpl: async (url) => {
    assert.equal(url.hostname, 'maps.googleapis.com');
    assert.equal(url.searchParams.get('latlng'), '29,-110');
    assert.equal(url.searchParams.get('language'), 'es');
    return { ok: true, json: async () => ({ status: 'OK', results: [{ formatted_address: 'Dirección', address_components: [{ long_name: 'Sonora', types: ['administrative_area_level_1'] }, { long_name: 'Hermosillo', types: ['locality'] }] }] }) };
  } });
  assert.deepEqual(result, { address: 'Dirección', street: '', place: 'Hermosillo', status: 'OK',
    addressDetails: { street: '', neighborhood: '', postalCode: '', city: 'Hermosillo', state: 'Sonora', originalAddress: 'Dirección' } });
});

test('Google quota reservation completes before the external request starts', async () => {
  const order = [];
  await reverseGeocode(29, -110, {
    apiKey: 'test-key',
    beforeRequest: async () => { order.push('reserve'); },
    fetchImpl: async () => {
      order.push('google');
      return { ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) };
    },
  });
  assert.deepEqual(order, ['reserve', 'google']);

  await assert.rejects(reverseGeocode(29, -110, {
    apiKey: 'test-key',
    beforeRequest: async () => { throw new Error('quota blocked'); },
    fetchImpl: async () => { throw new Error('Google should not be called'); },
  }), /quota blocked/);
});

test('Google zero results, denied requests, quota, timeout and missing key are handled without leaking secrets', async () => {
  const response = (status) => async () => ({ ok: true, json: async () => ({ status, error_message: 'secret-test-key' }) });
  assert.equal((await reverseGeocode(0, 0, { apiKey: 'test', fetchImpl: response('ZERO_RESULTS') })).status, 'SIN_RESULTADOS');
  for (const status of ['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'UNKNOWN_ERROR']) {
    await assert.rejects(reverseGeocode(0, 0, { apiKey: 'test', fetchImpl: response(status) }), (error) => !error.message.includes('secret'));
  }
  await assert.rejects(reverseGeocode(0, 0, { apiKey: '' }), /GOOGLE_GEOCODING_API_KEY/);
  await assert.rejects(reverseGeocode(0, 0, { apiKey: 'test', fetchImpl: async () => { throw new Error('secret'); } }), /comunicarse/);
});

test('cancellation and provider failures stop further billable requests', async () => {
  const input = readGeocodingFile(Buffer.from('lat,lon\n29,-110\n30,-111'), '.csv');
  let calls = 0;
  await assert.rejects(processGeocodingFile(input, { geocode: async () => { calls++; throw new Error('Cuota'); } }), /Cuota/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(processGeocodingFile(input, { signal: controller.signal, geocode: async () => { calls++; } }), /cancelado/);
  assert.equal(calls, 1);
});

test('page renders configuration, progress, errors and download actions safely', async () => {
  const html = await ejs.renderFile('views/pages/georeferenciacion.ejs', {
    configured: false, message: '', messageType: '', currentUser: { isAdmin: false },
    locations: [], search: '', total: 0, page: 1, pages: 1,
    files: [
      { id: 'a', name: '<script>', lineNumber: '123', status: 'pendiente', processed: 25, total: 50 },
      { id: 'b', name: 'ready.csv', lineNumber: '123', status: 'listo', processed: 50, total: 50 },
      { id: 'c', name: 'error.csv', lineNumber: '123', status: 'error', processed: 0, total: 50, error: 'Cuota agotada' },
    ],
  });
  assert.ok(html.includes('GEOREFERENCIACIÓN'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('25 / 50 filas'));
  assert.ok(html.includes('/georeferenciacion/exportar-xlsx/b'));
  assert.ok(html.includes('Cuota agotada'));
  assert.ok(html.includes('disabled>Importar y geocodificar'));
});

test('routes require a session; admins reach every file and UECS only files uploaded by UECS', async () => {
  const queries = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, parameters) => {
      if (sql.startsWith('INSERT IGNORE')) return [{ affectedRows: 1 }];
      if (sql.startsWith('SELECT request_count')) return [[{ requestCount: 0, isBlocked: 0 }]];
      if (sql.includes('g.file_uuid = ?')) queries.push({ sql, parameters });
      return sql.startsWith('DELETE') ? [{ affectedRows: 0 }] : [[]];
    },
  };
  const app = express();
  app.use((req, res, next) => {
    const kind = req.headers['x-test-session'];
    if (kind) req.session = { userId: 7, isAdmin: kind === 'admin', role: kind === 'admin' ? 'admin' : kind };
    next();
  });
  app.use('/georeferenciacion', createGeoreferenciacionRouter(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/georeferenciacion`;
  try {
    const unauthenticated = await fetch(base, { redirect: 'manual' });
    assert.equal(unauthenticated.status, 302);
    assert.equal(unauthenticated.headers.get('location'), '/');
    for (const [path, method] of [['', 'GET'], ['/importar', 'POST'], ['/exportar/foreign', 'GET'], ['/exportar-xlsx/foreign', 'GET'], ['/eliminar/foreign', 'POST']]) {
      assert.equal((await fetch(base + path, { method, headers: { 'x-test-session': 'user' } })).status, 403);
    }
    assert.equal(queries.length, 0);
    for (const session of ['admin', 'uecs']) {
      const headers = { 'x-test-session': session };
      assert.equal((await fetch(`${base}/exportar-xlsx/foreign`, { headers })).status, 404);
      await fetch(`${base}/eliminar/foreign`, { method: 'POST', headers, redirect: 'manual' });
    }
    assert.equal(queries.length, 4);
    for (const { sql, parameters } of queries.slice(0, 2)) {
      assert.ok(!sql.includes('owner_group') && !sql.includes('user_id'));
      assert.deepEqual(parameters, ['foreign']);
    }
    for (const { sql, parameters } of queries.slice(2)) {
      assert.ok(sql.includes('g.owner_group = ?'));
      assert.deepEqual(parameters, ['foreign', 'uecs']);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('only successful unique coordinates are persisted with the four requested fields', async () => {
  const input = readGeocodingFile(Buffer.from('lat,lon\n29,-110\n29,-110\n0,0\n,-110'), '.csv');
  const saved = [];
  const pool = { execute: async (sql, values) => { saved.push({ sql, values }); } };
  await processGeocodingFile(input, {
    geocode: async (lat) => lat === 0 ? { status: 'SIN_RESULTADOS', address: '', place: '' } : { status: 'OK', address: 'Dirección', place: 'Hermosillo' },
    onLocation: (location) => saveGeocodingLocation(pool, location),
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].values, ['Dirección', 'Hermosillo', 29, -110, '', '', 'REQUIERE_REVISION', null]);
  assert.ok(saved[0].sql.includes('ON DUPLICATE KEY UPDATE'));
});

test('only admins see the georeferencing menu entry', async () => {
  for (const isAdmin of [false, true]) {
    const html = await ejs.renderFile('views/includes/header.ejs', { currentUser: { isAdmin } });
    assert.equal(html.includes('href="/georeferenciacion"'), isAdmin);
  }
});

test('registered coordinates reuse database results across files without external calls or writes', async () => {
  const saved = { address: 'Dirección guardada', place: 'Ciudad', status: 'OK',
    betweenStreet1: 'Hidalgo', betweenStreet2: 'Morelos', crossStreetStatus: 'ENCONTRADAS' };
  let reads = 0;
  const forbidden = async () => assert.fail('Registered coordinates must not call external services or rewrite storage');
  const input = readGeocodingFile(Buffer.from('lat,lon\n29,-110\n29,-110\n,-110'), '.csv');
  for (let i = 0; i < 2; i++) {
    const rows = await processGeocodingFile(input, {
      findLocation: async (lat, lng) => { reads++; assert.deepEqual([lat, lng], [29, -110]); return saved; },
      geocode: forbidden, crossStreets: forbidden, onLocation: forbidden,
    });
    for (const row of rows.slice(1, 3)) {
      assert.equal(row[rows[0].indexOf('ubicacion')], 'Dirección guardada');
      assert.equal(row[rows[0].indexOf('entre_calle_2')], 'Morelos');
      assert.equal(row[rows[0].indexOf('estado_entrecalles')], 'ENCONTRADAS');
    }
    assert.equal(rows[1][rows[0].indexOf('antena')], rows[2][rows[0].indexOf('antena')]);
  }
  assert.equal(reads, 2);
});

test('existing incomplete entrecalles stay cached while only new coordinates call providers', async () => {
  const input = readGeocodingFile(Buffer.from('lat,lon\n29,-110\n30,-111\n30,-111'), '.csv');
  const calls = [], stored = [];
  const rows = await processGeocodingFile(input, {
    findLocation: async (lat) => lat === 29 ? { address: 'Guardada', place: 'Ciudad', status: 'OK', crossStreetStatus: 'SERVICIO_NO_DISPONIBLE' } : null,
    geocode: async (lat, lng) => { calls.push(['google', lat, lng]); return { address: 'Nueva', place: 'Ciudad', street: 'Juárez', status: 'OK' }; },
    crossStreets: async (lat, lng) => { calls.push(['roads', lat, lng]); return { betweenStreet1: 'A', betweenStreet2: 'B', crossStreetStatus: 'ENCONTRADAS' }; },
    onLocation: async (location) => stored.push(location),
  });
  assert.deepEqual(calls, [['google', 30, -111], ['roads', 30, -111]]);
  assert.equal(stored.length, 1);
  assert.equal(rows[1][rows[0].indexOf('estado_entrecalles')], 'SERVICIO_NO_DISPONIBLE');
  assert.equal(rows[2][rows[0].indexOf('entre_calle_1')], 'A');
});

test('database lookup uses indexed coordinate equality at stored decimal precision', async () => {
  const pool = { execute: async (sql, values) => {
    assert.ok(sql.includes('latitude = CAST(? AS DECIMAL(12,9))'));
    assert.ok(sql.includes('longitude = CAST(? AS DECIMAL(12,9))'));
    assert.deepEqual(values, [29.12345678912, -110]);
    return [[{ ubicacion: 'Guardada', lugar: 'Ciudad', entre_calle_1: 'A', entre_calle_2: 'B', estado_entrecalles: 'ENCONTRADAS' }]];
  } };
  assert.deepEqual(await findGeocodingLocation(pool, 29.12345678912, -110), {
    address: 'Guardada', place: 'Ciudad', betweenStreet1: 'A', betweenStreet2: 'B', crossStreetStatus: 'ENCONTRADAS', status: 'OK',
  });
  assert.equal(await findGeocodingLocation({ execute: async () => [[]] }, 0, 0), null);
});

test('a failed database lookup stops processing instead of making external requests', async () => {
  await assert.rejects(processGeocodingFile(readGeocodingFile(Buffer.from('lat,lon\n29,-110'), '.csv'), {
    findLocation: async () => { throw new Error('Database unavailable'); },
    geocode: async () => assert.fail('Must not fall back to billable requests'),
  }), /Database unavailable/);
});

test('UECS and regular users only see their group while administrators see every file', async () => {
  const { fileGroupOf, visibleFiles } = await import('../src/fileGroups.js');
  assert.equal(fileGroupOf({ role: 'uecs' }), 'uecs');
  for (const role of ['admin', 'semiadmin', 'usuario', undefined]) assert.equal(fileGroupOf({ role }), 'general');
  assert.deepEqual(visibleFiles({ role: 'uecs', isAdmin: false }, 'r'), { where: 'r.owner_group = ?', values: ['uecs'] });
  for (const role of ['usuario', 'semiadmin']) {
    assert.deepEqual(visibleFiles({ role, isAdmin: false }, 'r'), { where: 'r.owner_group = ?', values: ['general'] });
  }
  assert.deepEqual(visibleFiles({ role: 'admin', isAdmin: true }, 'r'), { where: 'TRUE', values: [] });
});
