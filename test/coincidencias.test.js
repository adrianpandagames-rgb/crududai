import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { distanceMetres, extractLineRecords, findCoincidences, lineFromFileName } from '../src/coincidenciasService.js';
import { parsePlanningTime, parsePlanningTimestamp } from '../src/planeacionService.js';
import { processRutaCsv } from '../src/rutaService.js';
import { createCoincidenciasRouter } from '../src/coincidenciasRouter.js';

const at = (text) => Date.parse(`${text}Z`);
// One file per line unless the test says otherwise.
const record = (line, time, lat, lng, extra = {}) => ({ line, file: `${line}.csv`, fileIndex: line.charCodeAt(0), row: 1,
  time: at(time), lat, lng, ubicacion: '', lugar: '', ...extra });
const pairOf = (result, ...lines) => result.pairs.find((pair) => pair.lines.join('-') === lines.join('-'));

test('timestamps keep the seconds while planning times stay at the minute', () => {
  assert.equal(parsePlanningTimestamp('13/10/2026', '14:05:30'), at('2026-10-13T14:05:30'));
  assert.equal(parsePlanningTimestamp('2026-10-13 02:05:30 p. m.'), at('2026-10-13T14:05:30'));
  assert.equal(parsePlanningTime('13/10/2026', '14:05:30'), '2026-10-13T14:05');
  assert.equal(parsePlanningTimestamp('31/02/2026', '10:00'), null);
});

test('the line comes from the digits in the file name', () => {
  assert.equal(lineFromFileName('Sábana 662 123 4567 (Telcel).xlsx'), '6621234567');
  assert.equal(lineFromFileName('objetivo-norte.csv'), 'objetivo-norte');
  assert.equal(lineFromFileName('6621234567-20261013.xlsx'), '6621234567');
});

test('lines meet at the same antenna or a nearby one within the time window', () => {
  // About 300 m north of the first antenna.
  const near = 29.1 + 300 / 111195;
  const records = [
    record('A', '2026-10-13T10:00:00', 29.1, -110.9),
    record('B', '2026-10-13T10:09:59', 29.1, -110.9),
    record('C', '2026-10-13T10:05:00', near, -110.9),
    record('D', '2026-10-13T10:20:01', 29.1, -110.9),
    record('E', '2026-10-13T10:01:00', 29.2, -110.9),
    record('A', '2026-10-13T10:02:00', 29.1, -110.9),
  ];
  const result = findCoincidences(records, { minutes: 10, metres: 500 });
  assert.deepEqual(result.pairs.map((pair) => pair.lines.join('-')).sort(), ['A-B', 'A-C', 'B-C']);
  const ab = pairOf(result, 'A', 'B');
  assert.equal(ab.count, 2);
  assert.equal(ab.sameAntenna, 2);
  const ac = pairOf(result, 'A', 'C');
  assert.equal(ac.sameAntenna, 0);
  assert.ok(Math.abs(ac.minDistance - 300) <= 1);
  assert.equal(result.truncated, false);

  const sameOnly = findCoincidences(records, { minutes: 10, metres: 0 });
  assert.deepEqual(sameOnly.pairs.map((pair) => pair.lines.join('-')), ['A-B']);
});

test('a file is never compared with itself, nor a line repeated in another file', () => {
  const records = [
    record('A', '2026-10-13T10:00:00', 29.1, -110.9, { fileIndex: 0, file: 'a1.xlsx' }),
    record('A', '2026-10-13T10:01:00', 29.1, -110.9, { fileIndex: 0, file: 'a1.xlsx' }),
    record('A', '2026-10-13T10:02:00', 29.1, -110.9, { fileIndex: 1, file: 'a2.xlsx' }),
    record('C', '2026-10-13T10:03:00', 29.1, -110.9, { fileIndex: 2, file: 'c.xlsx' }),
  ];
  const result = findCoincidences(records);
  assert.deepEqual(result.pairs.map((pair) => [pair.files, pair.lines, pair.count]), [
    [['a1.xlsx', 'c.xlsx'], ['A', 'C'], 2],
    [['a2.xlsx', 'c.xlsx'], ['A', 'C'], 1],
  ]);
  assert.equal(result.total, 3);
});

test('the detail list stops at the limit while the pair totals keep counting', () => {
  const records = Array.from({ length: 6 }, (_, index) => record(index % 2 ? 'A' : 'B', `2026-10-13T10:0${index}:00`, 29.1, -110.9));
  const result = findCoincidences(records, { maxDetail: 2 });
  assert.equal(result.matches.length, 2);
  assert.equal(result.total, 9);
  assert.equal(result.pairs[0].count, 9);
  assert.equal(result.truncated, true);
});

test('records take their position from Ubicaciones and skip rows without date or coordinates', () => {
  const rows = processRutaCsv('antena,fecha,hora\nABC,13/10/2026,10:00:05\nXYZ,13/10/2026,10:01:00\nABC,,\n', [
    { idUbicacion: 'ABC', latitude: 29.1, longitude: -110.9, ubicacion: 'Centro', lugar: 'Hermosillo' },
  ]);
  const result = extractLineRecords(rows, { file: 'a.csv', line: '662' });
  assert.equal(result.total, 3);
  assert.equal(result.withoutPosition, 1);
  assert.equal(result.withoutTime, 1);
  assert.deepEqual(result.records, [{ file: 'a.csv', line: '662', row: 1, time: at('2026-10-13T10:00:05'),
    fileIndex: 0, lat: 29.1, lng: -110.9, ubicacion: 'Centro', lugar: 'Hermosillo' }]);
  assert.ok(distanceMetres({ lat: 29.1, lng: -110.9 }, { lat: 29.1, lng: -110.9 }) === 0);
});

test('the Mapeo menu links to the coincidences page', async () => {
  const template = fileURLToPath(new URL('../views/includes/header.ejs', import.meta.url));
  const html = await ejs.renderFile(template, { currentUser: { isAdmin: false }, currentPath: '/coincidencias' });
  assert.ok(html.includes('href="/coincidencias" aria-current="page"'));
});

test('the search compares several uploaded files and validates the request', async (t) => {
  const app = express();
  app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
  app.use('/coincidencias', createCoincidenciasRouter({ query: async () => [[
    { idUbicacion: 'ABC', latitude: 29.1, longitude: -110.9, ubicacion: 'Centro', lugar: 'Hermosillo' },
  ]] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/coincidencias/buscar`;
  const csv = (text) => new Blob([text], { type: 'text/csv' });

  const body = new FormData();
  body.append('minutos', '10');
  body.append('metros', '0');
  body.append('archivos', csv('antena,fecha,hora\nABC,13/10/2026,10:00:00\n'), '6621111111.csv');
  body.append('linea', '');
  body.append('archivos', csv('antena,fecha,hora\nABC,13/10/2026,10:08:00\nABC,13/10/2026,11:00:00\n'), 'b.csv');
  body.append('linea', '6622222222');
  const response = await fetch(url, { method: 'POST', body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result.files.map((file) => [file.line, file.usable]), [['6621111111', 1], ['6622222222', 2]]);
  assert.equal(result.total, 1);
  assert.deepEqual(result.pairs[0].lines, ['6621111111', '6622222222']);
  assert.equal(result.matches[0].gapMinutes, 8);
  assert.deepEqual(result.pairs[0].places, ['Centro · Hermosillo']);

  const single = new FormData();
  single.append('archivos', csv('antena,fecha\nABC,13/10/2026\n'), 'a.csv');
  assert.equal((await fetch(url, { method: 'POST', body: single })).status, 400);

  const sameLine = new FormData();
  for (const name of ['a.csv', 'b.csv']) {
    sameLine.append('archivos', csv('antena,fecha\nABC,13/10/2026\n'), name);
    sameLine.append('linea', '662');
  }
  const sameLineResponse = await fetch(url, { method: 'POST', body: sameLine });
  assert.equal(sameLineResponse.status, 400);
  assert.match((await sameLineResponse.json()).error, /más de un archivo/);
});
