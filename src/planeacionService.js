import { findHeaderColumn, firstListedValue, LATITUDE_HEADERS, LONGITUDE_HEADERS, normalizeRutaValue, parseCoordinateNumber } from './rutaService.js';

const pad = (value) => String(value).padStart(2, '0');

// "HH:MM[:SS] [a. m.|p. m.]" → [hours, minutes, seconds], or null.
const parseClock = (text) => {
  const match = String(text ?? '').trim().toLowerCase()
    .match(/(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  const meridiem = match[4]?.[0];
  if (minutes > 59 || seconds > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'a' && hours === 12) hours = 0;
    if (meridiem === 'p' && hours < 12) hours += 12;
  } else if (hours > 23) return null;
  return [hours, minutes, seconds];
};

// Dates come as dd/mm/yyyy (Mexican files and the Excel import) or yyyy-mm-dd, optionally with the time.
// Returns [year, month, day, hours, minutes, seconds], or null.
function parseDateTimeParts(dateValue, timeValue = '') {
  const text = String(dateValue ?? '').trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) [, year, month, day] = match.map(Number);
  else if ((match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/))) {
    [, day, month, year] = match.map(Number);
    if (year < 100) year += 2000;
  } else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const clock = parseClock(String(timeValue ?? '').trim() || text.slice(match[0].length)) || [0, 0, 0];
  return [year, month, day, ...clock];
}

// "YYYY-MM-DDTHH:MM" so the browser can compare it directly with datetime-local inputs.
export function parsePlanningTime(dateValue, timeValue = '') {
  const parts = parseDateTimeParts(dateValue, timeValue);
  if (!parts) return null;
  const [year, month, day, hours, minutes] = parts;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}`;
}

// Milliseconds with the seconds kept, read as UTC so files from the same carrier compare without
// any shift; the result is only meant for differences and for formatting back.
export function parsePlanningTimestamp(dateValue, timeValue = '') {
  const parts = parseDateTimeParts(dateValue, timeValue);
  if (!parts) return null;
  const [year, month, day, hours, minutes, seconds] = parts;
  return Date.UTC(year, month - 1, day, hours, minutes, seconds);
}

export function extractPlanningPoints(rows) {
  const headers = (rows[0] || []).map(normalizeRutaValue);
  const latIndex = findHeaderColumn(headers, LATITUDE_HEADERS);
  const lngIndex = findHeaderColumn(headers, LONGITUDE_HEADERS);
  const azimuthIndex = headers.findIndex((header) => /azimut|azimuth|acimut/.test(header));
  const dateIndex = findHeaderColumn(headers, ['fecha', 'date']);
  const timeIndex = findHeaderColumn(headers, ['hora', 'time']);
  const points = [];
  const times = {};
  let omitted = 0;
  let missingAzimuth = 0;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (dateIndex >= 0) {
      const time = parsePlanningTime(row[dateIndex], timeIndex >= 0 && timeIndex !== dateIndex ? row[timeIndex] : '');
      if (time) times[index] = time;
    }
    const rawLat = latIndex >= 0 ? firstListedValue(row[latIndex]) : '';
    const rawLng = lngIndex >= 0 ? firstListedValue(row[lngIndex]) : '';
    const lat = String(rawLat ?? '').trim() ? parseCoordinateNumber(rawLat, rows.delimiter) : null;
    const lng = String(rawLng ?? '').trim() ? parseCoordinateNumber(rawLng, rows.delimiter) : null;
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      omitted++;
      continue;
    }
    const rawAzimuth = String(azimuthIndex >= 0 ? firstListedValue(row[azimuthIndex]) ?? '' : '').trim().replace(/°/g, '').replace(',', '.');
    const value = rawAzimuth ? Number(rawAzimuth) : NaN;
    const azimuth = Number.isFinite(value) ? ((value % 360) + 360) % 360 : null;
    if (azimuth === null) missingAzimuth++;
    points.push({ lat, lng, azimuth, row: index, ...(times[index] ? { time: times[index] } : {}) });
  }
  return { points, omitted, missingAzimuth, times, hasTimes: Object.keys(times).length > 0 };
}
