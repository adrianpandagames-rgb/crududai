import { antennaColumns } from './planeacion-antenas.js?v=8';

const minutesOf = (clock) => {
  const [hours, minutes] = String(clock).split(':').map(Number);
  return hours * 60 + minutes;
};

// Great-circle distance in metres.
export function distanceMetres(a, b) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(Math.sqrt(h), 1));
}

// The night a "YYYY-MM-DDTHH:MM" record belongs to, named by the date it started, or null outside the window.
// A window that crosses midnight (22:00–06:00) files the early hours under the previous day.
export function nightOf(time, start = '22:00', end = '06:00') {
  const match = String(time ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const minute = Number(match[4]) * 60 + Number(match[5]);
  const from = minutesOf(start);
  const to = minutesOf(end);
  const wraps = from > to;
  if (wraps ? minute < from && minute >= to : minute < from || minute >= to) return null;
  if (!wraps || minute >= from) return `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  return date.toISOString().slice(0, 10);
}

// Ranks where the line spends the night: sites seen in the most distinct nights first. Sites within
// `radius` metres of a busier one count with it, so the cells of one tower are not split.
// `include(row)` narrows the records (the period filter); `minShare` is the percentage of analysed nights.
export function findOvernightLocations(data, {
  start = '22:00', end = '06:00', minShare = 20, radius = 300, include = () => true,
} = {}) {
  const columns = antennaColumns(data.headers);
  const records = [];
  for (const point of data.points) {
    if (!point.time || !include(point.row)) continue;
    const night = nightOf(point.time, start, end);
    if (night) records.push({ ...point, night });
  }
  const nights = new Set(records.map((record) => record.night));

  const sites = new Map();
  for (const record of records) {
    const key = `${record.lat.toFixed(6)},${record.lng.toFixed(6)}`;
    if (!sites.has(key)) sites.set(key, { lat: record.lat, lng: record.lng, records: [] });
    sites.get(key).records.push(record);
  }
  const clusters = [];
  for (const site of [...sites.values()].sort((a, b) => b.records.length - a.records.length)) {
    const cluster = radius > 0 && clusters.find((candidate) => distanceMetres(candidate, site) <= radius);
    if (cluster) cluster.records.push(...site.records);
    else clusters.push({ lat: site.lat, lng: site.lng, records: [...site.records] });
  }

  // The first and last record of each night tell where the line settles and where it wakes up.
  const byNight = new Map();
  for (const record of records) {
    const bounds = byNight.get(record.night);
    if (!bounds) byNight.set(record.night, { first: record, last: record });
    else {
      if (record.time < bounds.first.time) bounds.first = record;
      if (record.time >= bounds.last.time) bounds.last = record;
    }
  }

  const cell = (rowNumber, column) => (column >= 0 ? String(data.rows[rowNumber - 1]?.[column] ?? '').trim() : '');
  const mostCommon = (values) => {
    const counts = new Map();
    for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const locations = clusters.map((cluster) => {
    const rows = new Set(cluster.records.map((record) => record.row));
    const clusterNights = [...new Set(cluster.records.map((record) => record.night))].sort();
    let settles = 0;
    let wakes = 0;
    for (const { first, last } of byNight.values()) {
      if (rows.has(first.row)) settles++;
      if (rows.has(last.row)) wakes++;
    }
    const rowNumbers = [...rows].sort((a, b) => a - b);
    return {
      lat: cluster.lat, lng: cluster.lng,
      coordinates: `${cluster.lat.toFixed(6)}, ${cluster.lng.toFixed(6)}`,
      name: mostCommon(rowNumbers.map((row) => cell(row, columns.antenna))) || 'Sin antena',
      ubicacion: mostCommon(rowNumbers.map((row) => cell(row, columns.location))),
      lugar: mostCommon(rowNumbers.map((row) => cell(row, columns.place))),
      rows: rowNumbers,
      nights: clusterNights.length,
      share: clusterNights.length / nights.size * 100,
      firstNight: clusterNights[0],
      lastNight: clusterNights.at(-1),
      settles,
      wakes,
    };
  }).filter((location) => location.share >= minShare)
    .sort((a, b) => b.nights - a.nights || b.rows.length - a.rows.length);
  return { totalNights: nights.size, nightRecords: records.length, locations };
}
