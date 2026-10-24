import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanningPoints, parsePlanningTime } from '../src/planeacionService.js';
import { findHeaderColumn, processRutaCsv } from '../src/rutaService.js';
import { coverageSector } from '../public/js/planeacion-geometry.js';
import { frequencyScale, rowMatches, selectionCsv } from '../public/js/planeacion-antenas.js';

test('columns such as Colonia or Plataforma are not taken for longitude or latitude', () => {
  const headers = ['colonia', 'plataforma', 'antena', 'latitud', 'longitud', 'azimut'];
  assert.equal(findHeaderColumn(headers, ['latitud', 'latitude', 'lat']), 3);
  assert.equal(findHeaderColumn(headers, ['longitud', 'longitude', 'lon', 'long', 'lng']), 4);
  assert.equal(findHeaderColumn(['latitud antena', 'lat.'], ['latitud', 'latitude', 'lat']), 0);
  assert.equal(findHeaderColumn(['latitudantena'], ['latitud', 'latitude', 'lat']), 0);
  assert.equal(findHeaderColumn(['salon', 'relacion'], ['longitud', 'longitude', 'lon', 'long', 'lng']), -1);

  const rows = processRutaCsv('Colonia,Plataforma,Antena,Latitud,Longitud,Azimut\nCentro,A,X,29.07,-110.95,120\n', []);
  assert.deepEqual(extractPlanningPoints(rows).points, [{ lat: 29.07, lng: -110.95, azimuth: 120, row: 1 }]);
});

test('Ruta fills coordinates into the real columns and keeps Colonia and Plataforma intact', () => {
  const rows = processRutaCsv('Colonia,Plataforma,Antena\nCentro,P1,ABC\n', [
    { idUbicacion: 'ABC', latitude: 29.1, longitude: -110.9, ubicacion: 'Centro', lugar: 'Hermosillo' },
  ]);
  const column = (name) => rows[0].indexOf(name);
  assert.equal(rows[1][column('Colonia')], 'Centro');
  assert.equal(rows[1][column('Plataforma')], 'P1');
  assert.equal(String(rows[1][column('latitud')]), '29.1');
  assert.equal(String(rows[1][column('longitud')]), '-110.9');
});

test('dates and times are read in the usual formats', () => {
  assert.equal(parsePlanningTime('13/10/2026', '14:05:09'), '2026-10-13T14:05');
  assert.equal(parsePlanningTime('2026-10-13 08:30'), '2026-10-13T08:30');
  assert.equal(parsePlanningTime('13-10-26', '2:15 p. m.'), '2026-10-13T14:15');
  assert.equal(parsePlanningTime('13/10/2026', '12:00 a. m.'), '2026-10-13T00:00');
  assert.equal(parsePlanningTime('31/02/2026'), null);
  assert.equal(parsePlanningTime('ayer'), null);

  const result = extractPlanningPoints([['fecha', 'hora', 'latitud', 'longitud'], ['13/10/2026', '14:05', '29', '-110'], ['x', '', '29', '-110']]);
  assert.equal(result.hasTimes, true);
  assert.deepEqual(result.times, { 1: '2026-10-13T14:05' });
  assert.equal(result.points[0].time, '2026-10-13T14:05');
  assert.equal('time' in result.points[1], false);
});

test('the sector opening follows the chosen beamwidth', () => {
  const rad = Math.PI / 180;
  const bearing = ([phi, lambda], lat, lng) => {
    const delta = (lambda - lng) * rad;
    return (Math.atan2(Math.sin(delta) * Math.cos(phi * rad), Math.cos(lat * rad) * Math.sin(phi * rad)
      - Math.sin(lat * rad) * Math.cos(phi * rad) * Math.cos(delta)) / rad + 360) % 360;
  };
  const sector = coverageSector(29.1, -110.9, 100, 500, 120);
  assert.ok(Math.abs(bearing(sector[1], 29.1, -110.9) - 40) < 0.00001);
  assert.ok(Math.abs(bearing(sector.at(-2), 29.1, -110.9) - 160) < 0.00001);
});

test('frequency colours split the busiest site into ranges', () => {
  const scale = frequencyScale(40);
  assert.deepEqual(scale.legend.map(({ label }) => label), ['1–8', '9–16', '17–24', '25–32', '33–40']);
  assert.equal(scale.colorFor(1), scale.legend[0].color);
  assert.equal(scale.colorFor(40), scale.legend[4].color);
  assert.equal(frequencyScale(1).legend.length, 1);
});

test('table search ignores case and accents', () => {
  assert.ok(rowMatches(['Hermosillo', 'Ubicación Centro'], 'ubicacion'));
  assert.ok(rowMatches(['6621234567'], ''));
  assert.ok(!rowMatches(['Nogales'], 'guaymas'));
});

test('the selection export keeps the headers and the chosen records in order', () => {
  const csv = selectionCsv(['Antena', 'Lugar'], [['A', 'Centro'], ['B', 'Dice "hola"'], ['C', 'Norte']], new Set([3, 2]));
  assert.equal(csv, '﻿"Antena","Lugar"\r\n"B","Dice ""hola"""\r\n"C","Norte"\r\n');
});

test('Excel annexes with title rows above the table and US-style dates are read correctly', async () => {
  const { default: XLSX } = await import('xlsx');
  const { processRutaXlsx } = await import('../src/rutaService.js');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['ANEXO ÚNICO'], ['Oficio 123'], [],
    ['No.', 'FECHA Y HORA', 'HORA', 'LATITUD', 'LONGITUD', 'Azimut'],
    [1, 46301.62553240741, 0.5, 29.07, -110.95, 120],
  ]);
  sheet.B5.z = 'm/d/yy h:mm';
  sheet.C5.z = 'hh:mm:ss';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Hoja1');
  const rows = processRutaXlsx(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), []);
  assert.deepEqual(rows[0].slice(0, 6), ['No.', 'FECHA Y HORA', 'HORA', 'LATITUD', 'LONGITUD', 'Azimut']);
  assert.equal(rows[1][1], '06/10/2026 15:00:46');
  assert.equal(rows[1][2], '12:00:00');
  const result = extractPlanningPoints(rows);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].time, '2026-10-06T12:00');
});
