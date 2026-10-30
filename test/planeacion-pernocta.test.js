import test from 'node:test';
import assert from 'node:assert/strict';
import { nightOf, findOvernightLocations, distanceMetres } from '../public/js/planeacion-pernocta.js';

test('early-hours records belong to the night that started the previous day', () => {
  assert.equal(nightOf('2026-03-15T23:10'), '2026-03-15');
  assert.equal(nightOf('2026-03-16T02:00'), '2026-03-15');
  assert.equal(nightOf('2026-03-01T05:59'), '2026-02-28');
  assert.equal(nightOf('2026-03-16T06:00'), null);
  assert.equal(nightOf('2026-03-16T14:00'), null);
  assert.equal(nightOf('2026-03-16T03:00', '00:00', '05:00'), '2026-03-16');
  assert.equal(nightOf('2026-03-16T05:30', '00:00', '05:00'), null);
  assert.equal(nightOf(undefined), null);
});

test('distance between nearby coordinates is measured in metres', () => {
  const metres = distanceMetres({ lat: 29, lng: -110 }, { lat: 29.001, lng: -110 });
  assert.ok(metres > 110 && metres < 112);
});

const point = (row, lat, lng, time) => ({ row, lat, lng, azimuth: null, time });

test('locations are ranked by distinct nights and filtered by their share of the nights analysed', () => {
  const data = {
    headers: ['Antena', 'Ubicación', 'Lugar'],
    rows: [['CASA'], ['CASA'], ['CASA-2'], ['CASA'], ['TRABAJO'], ['TRABAJO'], ['HOTEL'], ['CASA']],
    points: [
      point(1, 29, -110, '2026-03-01T23:00'),
      point(2, 29, -110, '2026-03-02T01:00'),
      // 111 m away: same site as CASA with the default 300 m grouping.
      point(3, 29.001, -110, '2026-03-02T23:30'),
      point(4, 29, -110, '2026-03-04T05:00'),
      point(5, 29.1, -110.1, '2026-03-02T12:00'),
      point(6, 29.1, -110.1, '2026-03-02T21:59'),
      point(7, 30, -111, '2026-03-04T22:00'),
      point(8, 29, -110, '2026-03-05T03:00'),
    ],
  };
  const result = findOvernightLocations(data);
  assert.equal(result.totalNights, 4);
  assert.equal(result.nightRecords, 6);
  assert.equal(result.locations.length, 2);
  const [home, hotel] = result.locations;
  assert.equal(home.name, 'CASA');
  assert.equal(home.nights, 4);
  assert.equal(home.share, 100);
  assert.deepEqual(home.rows, [1, 2, 3, 4, 8]);
  assert.equal(home.firstNight, '2026-03-01');
  assert.equal(home.lastNight, '2026-03-04');
  assert.equal(home.settles, 3);
  assert.equal(home.wakes, 4);
  assert.equal(hotel.name, 'HOTEL');
  assert.equal(hotel.settles, 1);

  assert.equal(findOvernightLocations(data, { minShare: 50 }).locations.length, 1);
  const exact = findOvernightLocations(data, { radius: 0 });
  assert.equal(exact.locations.length, 3);
  assert.deepEqual(exact.locations[0].rows, [1, 2, 4, 8]);
});

test('the period filter and records without time are left out', () => {
  const data = {
    headers: ['antena'], rows: [['A'], ['B']],
    points: [point(1, 29, -110, '2026-03-01T23:00'), point(2, 30, -111, '2026-03-02T23:00'), { row: 3, lat: 1, lng: 1 }],
  };
  const result = findOvernightLocations(data, { include: (row) => row !== 2 });
  assert.equal(result.totalNights, 1);
  assert.deepEqual(result.locations.map((location) => location.name), ['A']);
  assert.deepEqual(findOvernightLocations({ headers: [], rows: [], points: [] }), { totalNights: 0, nightRecords: 0, locations: [] });
});
