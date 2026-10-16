import { normalizeRutaValue, parseCoordinateNumber } from './rutaService.js';

export function extractPlanningPoints(rows) {
  const headers = (rows[0] || []).map(normalizeRutaValue);
  const find = (names) => headers.findIndex((header) => names.some((name) => header.includes(name)));
  const latIndex = find(['latitud', 'latitude', 'lat']);
  const lngIndex = find(['longitud', 'longitude', 'lon', 'long', 'lng']);
  const azimuthIndex = headers.findIndex((header) => /azimut|azimuth|acimut/.test(header));
  const points = [];
  let omitted = 0;
  let missingAzimuth = 0;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const rawLat = row[latIndex];
    const rawLng = row[lngIndex];
    const lat = String(rawLat ?? '').trim() ? parseCoordinateNumber(rawLat, rows.delimiter) : null;
    const lng = String(rawLng ?? '').trim() ? parseCoordinateNumber(rawLng, rows.delimiter) : null;
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      omitted++;
      continue;
    }
    const rawAzimuth = String(row[azimuthIndex] ?? '').trim().replace(/°/g, '').replace(',', '.');
    const value = rawAzimuth ? Number(rawAzimuth) : NaN;
    const azimuth = Number.isFinite(value) ? ((value % 360) + 360) % 360 : null;
    if (azimuth === null) missingAzimuth++;
    points.push({ lat, lng, azimuth, row: index });
  }
  return { points, omitted, missingAzimuth };
}
