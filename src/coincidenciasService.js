import {
  distanceMetres, findHeaderColumn, firstListedValue, LATITUDE_HEADERS, LONGITUDE_HEADERS, normalizeRutaValue, parseCoordinateNumber,
} from './rutaService.js';
import { parsePlanningTimestamp } from './planeacionService.js';

export const DEFAULT_MINUTES = 10;
export const DEFAULT_METRES = 500;
// Two busy lines in the same sector can pair hundreds of records each; the summary still counts
// every coincidence, only the detail list stops here.
export const MAX_DETAIL = 5000;
// Within this distance two records count as the same antenna (coordinates rounded by the carrier).
const SAME_ANTENNA_METRES = 1;

// "Sábana 662 123 4567 (Telcel).xlsx" → "6621234567"; names without a 10-digit run keep their text.
// A plain run wins first so "6621234567-20261013" does not glue the date onto the number.
export function lineFromFileName(name) {
  const base = String(name ?? '').replace(/\.[^.]+$/, '').trim();
  const digits = base.match(/(?<!\d)\d{10,15}(?!\d)/) || base.replace(/[\s()-]/g, '').match(/\d{10,15}/);
  return (digits ? digits[0] : base).slice(0, 50);
}

export { distanceMetres };

const pad = (value) => String(value).padStart(2, '0');
export function formatTimestamp(ms) {
  const date = new Date(ms);
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// `rows` come from processRutaCsv/processRutaXlsx, so antennas found in Ubicaciones already have coordinates.
// Records without a readable date or a valid position cannot be compared and are only counted.
// `fileIndex` tells apart two uploads with the same name, so mergeLineRecords can spot rows repeated between them.
export function extractLineRecords(rows, { file, line, fileIndex = 0 }) {
  const headers = (rows[0] || []).map(normalizeRutaValue);
  const latIndex = findHeaderColumn(headers, LATITUDE_HEADERS);
  const lngIndex = findHeaderColumn(headers, LONGITUDE_HEADERS);
  const dateIndex = findHeaderColumn(headers, ['fecha', 'date']);
  const timeIndex = findHeaderColumn(headers, ['hora', 'time']);
  const locationIndex = headers.findIndex((header) => /ubicacion|location/.test(header));
  const placeIndex = headers.findIndex((header) => /lugar|place/.test(header));
  const records = [];
  let withoutTime = 0;
  let withoutPosition = 0;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const time = dateIndex >= 0
      ? parsePlanningTimestamp(row[dateIndex], timeIndex >= 0 && timeIndex !== dateIndex ? row[timeIndex] : '')
      : null;
    const rawLat = latIndex >= 0 ? String(firstListedValue(row[latIndex]) ?? '').trim() : '';
    const rawLng = lngIndex >= 0 ? String(firstListedValue(row[lngIndex]) ?? '').trim() : '';
    const lat = rawLat ? parseCoordinateNumber(rawLat, rows.delimiter) : null;
    const lng = rawLng ? parseCoordinateNumber(rawLng, rows.delimiter) : null;
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      withoutPosition++;
      continue;
    }
    if (time === null) {
      withoutTime++;
      continue;
    }
    records.push({
      file, fileIndex, line, row: index, time, lat, lng,
      ubicacion: locationIndex >= 0 ? String(row[locationIndex] ?? '').trim() : '',
      lugar: placeIndex >= 0 ? String(row[placeIndex] ?? '').trim() : '',
    });
  }
  return { records, total: rows.length - 1, withoutTime, withoutPosition, hasDate: dateIndex >= 0 };
}

// Files of the same line are read as one: a row repeated in another file of that line (same time and
// position) counts once, while repeated rows inside a single file stay, since each one was its own event.
export function mergeLineRecords(records) {
  const kept = new Map();
  const seen = new Map();
  const merged = [];
  const duplicates = {};
  for (const record of records) {
    const key = JSON.stringify([record.line, record.time, record.lat, record.lng]);
    const occurrence = (seen.get(`${record.fileIndex}|${key}`) || 0) + 1;
    seen.set(`${record.fileIndex}|${key}`, occurrence);
    if (occurrence <= (kept.get(key) || 0)) {
      duplicates[record.line] = (duplicates[record.line] || 0) + 1;
      continue;
    }
    kept.set(key, occurrence);
    merged.push(record);
  }
  return { records: merged, duplicates };
}

const recordView = (record) => ({
  line: record.line, file: record.file, row: record.row, time: formatTimestamp(record.time),
  lat: record.lat, lng: record.lng, ubicacion: record.ubicacion, lugar: record.lugar,
});

// Every pair of records from different lines no more than `minutes` apart and `metres` away;
// a line is never compared with itself. Sorting by time keeps the scan to the records inside each window.
export function findCoincidences(records, { minutes = DEFAULT_MINUTES, metres = DEFAULT_METRES, maxDetail = MAX_DETAIL } = {}) {
  const windowMs = minutes * 60 * 1000;
  const sorted = [...records].sort((a, b) => a.time - b.time);
  const matches = [];
  const pairs = new Map();
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].time - a.time <= windowMs; j++) {
      const b = sorted[j];
      if (a.line === b.line) continue;
      const distance = distanceMetres(a, b);
      if (distance > metres) continue;
      total++;
      const sameAntenna = distance <= SAME_ANTENNA_METRES;
      const gapMinutes = (b.time - a.time) / 60000;
      const lines = [a.line, b.line].sort((x, y) => x.localeCompare(y, 'es', { numeric: true }));
      const key = JSON.stringify(lines);
      if (!pairs.has(key)) {
        pairs.set(key, { lines, count: 0, sameAntenna: 0, minDistance: Infinity, minGap: Infinity,
          first: a.time, last: b.time, places: new Set() });
      }
      const pair = pairs.get(key);
      pair.count++;
      if (sameAntenna) pair.sameAntenna++;
      pair.minDistance = Math.min(pair.minDistance, distance);
      pair.minGap = Math.min(pair.minGap, gapMinutes);
      pair.first = Math.min(pair.first, a.time);
      pair.last = Math.max(pair.last, b.time);
      for (const record of [a, b]) {
        const place = [record.ubicacion, record.lugar].filter(Boolean).join(' · ');
        if (place) pair.places.add(place);
      }
      if (matches.length < maxDetail) {
        matches.push({ pair: key, a: recordView(a), b: recordView(b), distance: Math.round(distance),
          gapMinutes: Math.round(gapMinutes * 100) / 100, sameAntenna });
      }
    }
  }
  const summary = [...pairs.entries()].map(([key, pair]) => ({
    key, lines: pair.lines, count: pair.count, sameAntenna: pair.sameAntenna,
    minDistance: Math.round(pair.minDistance), minGap: Math.round(pair.minGap * 100) / 100,
    first: formatTimestamp(pair.first), last: formatTimestamp(pair.last), places: [...pair.places].slice(0, 5),
  })).sort((x, y) => y.count - x.count || x.key.localeCompare(y.key));
  return { pairs: summary, matches, total, truncated: total > matches.length };
}
