import zlib from 'node:zlib';
import {
  detectCsvDelimiter, findHeaderColumn, firstListedValue, LATITUDE_HEADERS, LONGITUDE_HEADERS, normalizeRutaValue,
  parseCsv, parseCoordinateNumber,
} from './rutaService.js';
import { parsePlanningTimestamp } from './planeacionService.js';

// A Ruta result as a KMZ for Google Earth (and, the Antenas layer, Google My Maps). Every record of the file is in it:
//  1. Antenas (shown): one numbered point per antenna, coloured by how many records it has; its balloon lists all of them.
//  2. Recorrido por día (hidden): one line per day joining the antennas in time order.
//  3. Registros (hidden): one point per record with its date and time, so Google Earth's time slider plays the route.
// Records without a position cannot go on the map; they are listed in a folder of their own.
// Times in the files are local wall-clock times; Sonora keeps UTC-7 all year.
const UTC_OFFSET = /^[+-]\d{2}:\d{2}$/.test(process.env.RUTA_KMZ_UTC_OFFSET || '') ? process.env.RUTA_KMZ_UTC_OFFSET : '-07:00';

const ICON = 'https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png';
// From few to many records: green, yellow, orange, red (KML colours are aabbggrr).
const LEVELS = [
  { id: 'nivel1', color: 'ff3cb371', scale: 1.0, label: 'pocos registros' },
  { id: 'nivel2', color: 'ff00d7ff', scale: 1.2, label: 'algunos' },
  { id: 'nivel3', color: 'ff008cff', scale: 1.4, label: 'muchos' },
  { id: 'nivel4', color: 'ff2020e0', scale: 1.6, label: 'la mayor actividad' },
];

const xml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Balloon HTML goes inside CDATA; escaping > also keeps "]]>" from ever closing it early.
const cdata = (html) => `<![CDATA[${html}]]>`;

const pad = (value) => String(value).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const clockOf = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const whenOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${clockOf(ms)}${UTC_OFFSET}`; };

// Table attributes instead of a style on every cell: a file of thousands of records stays light enough to open.
const TABLE = '<table border="1" cellpadding="3" cellspacing="0" style="border-collapse:collapse;font-size:12px;white-space:nowrap">';
const recordsTable = (headers, records) => `${TABLE}<tr><th>#</th>`
  + headers.map((header) => `<th>${xml(header)}</th>`).join('')
  + '</tr>'
  + records.map((record) => `<tr><td>${record.row}</td>`
    + headers.map((_, index) => `<td>${xml(record.cells[index])}</td>`).join('')
    + '</tr>').join('')
  + '</table>';
// One record shown as a two-column card, easier to read in a small balloon than a wide row.
const recordCard = (headers, record) => TABLE
  + headers.map((header, index) => `<tr><th align="left">${xml(header)}</th><td>${xml(record.cells[index])}</td></tr>`).join('')
  + '</table>';

// Google Earth draws balloons with an embedded browser that freezes on huge tables (a busy antenna had 1,500 rows
// x 22 columns, ~900 KB). A balloon shows at most this many rows; every record stays whole in the Registros layer.
export const BALLOON_ROWS = 100;

const point = (lat, lng) => `<Point><coordinates>${lng},${lat},0</coordinates></Point>`;

export const readRutaRecords = (csvText) => {
  const text = String(csvText || '').replace(/^﻿/, '');
  const delimiter = detectCsvDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const headers = (rows[0] || []).map((header) => String(header ?? ''));
  const normalized = headers.map(normalizeRutaValue);
  const latIndex = findHeaderColumn(normalized, LATITUDE_HEADERS);
  const lngIndex = findHeaderColumn(normalized, LONGITUDE_HEADERS);
  const dateIndex = findHeaderColumn(normalized, ['fecha', 'date']);
  const timeIndex = findHeaderColumn(normalized, ['hora', 'time']);
  const antennaIndex = normalized.findIndex((header) => /antena|antenna/.test(header));
  const locationIndex = normalized.findIndex((header) => /ubicacion|location/.test(header));
  const placeIndex = normalized.findIndex((header) => /lugar|place/.test(header));

  const records = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = headers.map((_, column) => String(rows[index][column] ?? '').trim());
    if (!cells.some(Boolean)) continue;
    const rawLat = latIndex >= 0 ? String(firstListedValue(cells[latIndex]) ?? '').trim() : '';
    const rawLng = lngIndex >= 0 ? String(firstListedValue(cells[lngIndex]) ?? '').trim() : '';
    let lat = rawLat ? parseCoordinateNumber(rawLat, delimiter) : null;
    let lng = rawLng ? parseCoordinateNumber(rawLng, delimiter) : null;
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) lat = lng = null;
    const time = dateIndex >= 0
      ? parsePlanningTimestamp(cells[dateIndex], timeIndex >= 0 && timeIndex !== dateIndex ? cells[timeIndex] : '')
      : null;
    records.push({
      row: index, cells, lat, lng, time,
      antenna: antennaIndex >= 0 ? cells[antennaIndex] : '',
      ubicacion: locationIndex >= 0 ? cells[locationIndex] : '',
      lugar: placeIndex >= 0 ? cells[placeIndex] : '',
    });
  }
  return { headers, records };
};

// Records with a time first, in time order; the rest keep the file's order.
const byTime = (a, b) => (a.time === null) - (b.time === null) || (a.time ?? 0) - (b.time ?? 0) || a.row - b.row;

export const createRutaKml = (csvText, { lineNumber = '' } = {}) => {
  const { headers, records } = readRutaRecords(csvText);
  const located = records.filter((record) => record.lat !== null).sort(byTime);
  const unlocated = records.filter((record) => record.lat === null);

  // Antennas: same rounded coordinates. They keep the number the app wrote in the "antena" column, so the map and
  // the Excel name them alike; a file without that column is numbered in order of first appearance.
  const antennas = new Map();
  for (const record of [...located].sort((a, b) => a.row - b.row)) {
    const key = `${record.lat.toFixed(6)},${record.lng.toFixed(6)}`;
    if (!antennas.has(key)) antennas.set(key, { key, number: record.antenna || String(antennas.size + 1), lat: record.lat, lng: record.lng, records: [] });
    antennas.get(key).records.push(record);
    record.antennaKey = key;
  }
  // Logarithmic, so one very busy antenna does not leave every other one in the lowest colour.
  const most = Math.max(1, ...[...antennas.values()].map((antenna) => antenna.records.length));
  const levelOf = (count) => LEVELS[most === 1 ? 0
    : Math.min(LEVELS.length - 1, Math.floor((Math.log(count) / Math.log(most)) * LEVELS.length))];

  const title = `Ruta${lineNumber ? ` ${lineNumber}` : ''}`;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  out.push(`<name>${xml(title)}</name>`);
  const times = located.filter((record) => record.time !== null);
  const range = times.length ? `${dayOf(times[0].time)} ${clockOf(times[0].time)} a ${dayOf(times.at(-1).time)} ${clockOf(times.at(-1).time)}` : 'sin fechas legibles';
  out.push(`<description>${cdata(`<b>${xml(title)}</b><br>${records.length} registros, ${antennas.size} antenas.<br>Periodo: ${xml(range)}.`
    + (unlocated.length ? `<br>${unlocated.length} registros sin ubicación (carpeta "Sin ubicación").` : '')
    + '<br>Colores de antena: verde = pocos registros, amarillo, naranja, rojo = la mayor actividad.')}</description>`);
  for (const level of LEVELS) {
    out.push(`<Style id="${level.id}"><IconStyle><color>${level.color}</color><scale>${level.scale}</scale><Icon><href>${ICON}</href></Icon></IconStyle>`
      + '<LabelStyle><scale>0.9</scale></LabelStyle><BalloonStyle><text>$[description]</text></BalloonStyle></Style>');
  }
  out.push(`<Style id="registro"><IconStyle><color>ffff9933</color><scale>0.6</scale><Icon><href>${ICON}</href></Icon></IconStyle>`
    + '<LabelStyle><scale>0</scale></LabelStyle><BalloonStyle><text>$[description]</text></BalloonStyle></Style>');
  out.push('<Style id="recorrido"><LineStyle><color>ffff6600</color><width>3</width></LineStyle></Style>');

  // 1. Antenas
  out.push(`<Folder><name>Antenas (${antennas.size})</name><open>1</open>`);
  for (const antenna of antennas.values()) {
    const list = [...antenna.records].sort(byTime);
    const first = list.find((record) => record.time !== null);
    const last = [...list].reverse().find((record) => record.time !== null);
    const sample = list.find((record) => record.ubicacion || record.lugar) || list[0];
    const level = levelOf(list.length);
    const summary = `<b>Antena ${xml(antenna.number)}</b> — ${list.length} registro${list.length === 1 ? '' : 's'}<br>`
      + (sample.ubicacion ? `${xml(sample.ubicacion)}<br>` : '')
      + (sample.lugar ? `${xml(sample.lugar)}<br>` : '')
      + `${antenna.lat.toFixed(6)}, ${antenna.lng.toFixed(6)}<br>`
      + (first ? `Primer registro: ${dayOf(first.time)} ${clockOf(first.time)}<br>Último registro: ${dayOf(last.time)} ${clockOf(last.time)}<br>` : '');
    const perDay = new Map();
    for (const record of list) {
      const day = record.time === null ? 'Sin fecha' : dayOf(record.time);
      perDay.set(day, (perDay.get(day) || 0) + 1);
    }
    const dayCounts = perDay.size > 1
      ? `<br><b>Registros por día</b><br>${[...perDay].map(([day, count]) => `${xml(day)}: ${count}`).join('<br>')}<br>`
      : '';
    const shown = list.slice(0, BALLOON_ROWS);
    const more = list.length > shown.length
      ? `<br><i>Se muestran los primeros ${shown.length} de ${list.length} registros. Todos están completos en la capa "Registros", por día.</i>`
      : '';
    out.push(`<Placemark><name>${xml(antenna.number)}</name><styleUrl>#${level.id}</styleUrl>`
      + `<description>${cdata(`${summary}${dayCounts}<br>${recordsTable(headers, shown)}${more}`)}</description>${point(antenna.lat, antenna.lng)}</Placemark>`);
  }
  out.push('</Folder>');

  // 2. and 3. by day
  const days = new Map();
  for (const record of located) {
    const day = record.time === null ? 'Sin fecha' : dayOf(record.time);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(record);
  }
  const number = (record) => xml(antennas.get(record.antennaKey).number);

  out.push('<Folder><name>Recorrido por día</name><visibility>0</visibility>');
  for (const [day, list] of days) {
    if (day === 'Sin fecha') continue;
    // Consecutive records at the same antenna are one stop on the line.
    const stops = list.filter((record, index) => index === 0 || record.antennaKey !== list[index - 1].antennaKey);
    if (stops.length < 2) continue;
    const order = stops.map((record) => `${clockOf(record.time)} — antena ${number(record)}`).join('<br>');
    out.push(`<Placemark><name>${xml(day)} (${list.length} registros)</name><visibility>0</visibility><styleUrl>#recorrido</styleUrl>`
      + `<description>${cdata(`<b>Recorrido del ${xml(day)}</b><br>${order}`)}</description>`
      + `<LineString><tessellate>1</tessellate><coordinates>${stops.map((record) => `${record.lng},${record.lat},0`).join(' ')}</coordinates></LineString></Placemark>`);
  }
  out.push('</Folder>');

  out.push(`<Folder><name>Registros (${located.length})</name><visibility>0</visibility>`);
  for (const [day, list] of days) {
    out.push(`<Folder><name>${xml(day)} (${list.length})</name><visibility>0</visibility>`);
    for (const record of list) {
      const name = record.time === null ? `Fila ${record.row}` : clockOf(record.time);
      out.push(`<Placemark><name>${name}</name><visibility>0</visibility><styleUrl>#registro</styleUrl>`
        + (record.time === null ? '' : `<TimeStamp><when>${whenOf(record.time)}</when></TimeStamp>`)
        + `<description>${cdata(`<b>Fila ${record.row} — antena ${number(record)}</b><br>${recordCard(headers, record)}`)}</description>`
        + `${point(record.lat, record.lng)}</Placemark>`);
    }
    out.push('</Folder>');
  }
  out.push('</Folder>');

  // Without coordinates they cannot go on the map; listed in folders of BALLOON_ROWS so no description gets huge.
  if (unlocated.length) {
    out.push(`<Folder><name>Sin ubicación (${unlocated.length})</name>`
      + `<description>${cdata('<b>Registros sin coordenadas</b>: no se pueden poner en el mapa; se listan aquí por filas.')}</description>`);
    for (let start = 0; start < unlocated.length; start += BALLOON_ROWS) {
      const part = unlocated.slice(start, start + BALLOON_ROWS);
      out.push(`<Folder><name>Filas ${part[0].row}–${part.at(-1).row}</name>`
        + `<description>${cdata(recordsTable(headers, part))}</description></Folder>`);
    }
    out.push('</Folder>');
  }
  out.push('</Document></kml>');
  return out.join('\n');
};

// A ZIP with a single deflated doc.kml: what Google Earth and My Maps read as a KMZ.
export const zipSingleFile = (name, content, date = new Date()) => {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data);
  const fileName = Buffer.from(name, 'utf8');
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  // extra, comment, disk, internal and external attributes stay 0
  central.writeUInt32LE(0, 42); // offset of the local header

  const centralOffset = local.length + fileName.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, compressed, central, fileName, end]);
};

export const createRutaKmz = (csvText, options = {}) => zipSingleFile('doc.kml', createRutaKml(csvText, options));
