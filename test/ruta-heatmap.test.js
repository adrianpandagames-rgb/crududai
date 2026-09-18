import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRutaHeatmapPoints, generateRutaHeatmapImageFromCsv } from '../src/rutaService.js';

test('extractRutaHeatmapPoints only reads coordinates from the imported file', () => {
  const csv = [
    'linea,latitud,longitud,ubicacion',
    '1,19.4326,-99.1332,CDMX',
    '2,19.4326,-99.1332,CDMX',
    '3,19.4417,-99.1653,Alvaro Obregon',
    '',
  ].join('\n');

  const points = extractRutaHeatmapPoints(csv);

  assert.deepEqual(points, [
    { lat: 19.4326, lng: -99.1332, weight: 2 },
    { lat: 19.4417, lng: -99.1653, weight: 1 },
  ]);
});

test('generateRutaHeatmapImageFromCsv produces a PNG for the imported coordinate cluster', async () => {
  const csv = [
    'latitud,longitud',
    '19.4326,-99.1332',
    '19.4417,-99.1653',
  ].join('\n');

  const image = await generateRutaHeatmapImageFromCsv(csv, { width: 400, height: 240 });

  assert.ok(Buffer.isBuffer(image));
  assert.ok(image.length > 0);
  assert.equal(image.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
});
