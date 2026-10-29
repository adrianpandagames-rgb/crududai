import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAntennas, antennaClipboardHtml, antennaClipboardText } from '../public/js/planeacion-antenas.js';

test('antenna clipboard contains five columns without headings and uses all records for the percentage', () => {
  assert.equal(antennaClipboardText({
    coordinates: '29.000000, -110.000000', rows: [1, 2], ubicacion: 'Centro\nNorte', lugar: 'Hermosillo\tSonora',
  }, 3), '29.000000, -110.000000\t2\t66.67%\tCentro Norte\tHermosillo Sonora');
  assert.equal(antennaClipboardText({ coordinates: '', rows: [], ubicacion: '', lugar: '' }, 0), '\t0\t0.00%\t\t');
});

test('the antenna is also copied as a one-row table, so Excel keeps commas inside their cell', () => {
  const group = {
    coordinates: '31.036725, -114.840000', rows: [1],
    ubicacion: 'Av. Mar de Cortés, entre Calle Bilbao y <Sur>, C.P. 21850', lugar: 'San Felipe, Baja California',
  };
  assert.equal(antennaClipboardHtml(group, 4), '<table><tr><td>31.036725, -114.840000</td><td>1</td><td>25.00%</td>'
    + '<td>Av. Mar de Cortés, entre Calle Bilbao y &lt;Sur&gt;, C.P. 21850</td><td>San Felipe, Baja California</td></tr></table>');
});

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
