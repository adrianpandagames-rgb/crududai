import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAntennas } from '../public/js/planeacion-antenas.js';

test('antenna frequency counts repeated records across azimuths and keeps different antennas separate', () => {
  const groups = summarizeAntennas({
    headers: ['Antena', 'Ubicación', 'Lugar'],
    rows: [['A', 'Centro', 'Hermosillo'], ['A', 'Centro', 'Hermosillo'], ['B', 'Centro', 'Hermosillo']],
    points: [
      { row: 1, lat: 29, lng: -110, azimuth: 10 },
      { row: 2, lat: 29, lng: -110, azimuth: 90 },
      { row: 3, lat: 29, lng: -110, azimuth: 10 },
    ],
  });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].rows, [1, 2]);
  assert.equal(groups[0].points.length, 2);
  assert.equal(groups[0].ubicacion, 'Centro');
  assert.equal(groups[0].coordinates, '29.000000, -110.000000');
});

test('antenna summary includes records without coordinates and distinguishes different sites', () => {
  const groups = summarizeAntennas({
    headers: ['antena'], rows: [['A'], ['A'], ['A']],
    points: [{ row: 1, lat: 29, lng: -110 }, { row: 2, lat: 30, lng: -111 }],
  });
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[2].rows, [3]);
  assert.equal(groups[2].points.length, 0);
  assert.equal(groups[2].coordinates, 'Sin coordenadas válidas');
});
