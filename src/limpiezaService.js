// Limpieza de sábanas: quita las llamadas espejo (la copia "VOZ TRANSITO" que la compañía registra de una llamada
// saliente, una hora antes y sin ubicación) y entrega dos Excel: la sábana con solo los registros reales, con su
// resumen, y el archivo para Ruta (geoposicionamiento) con solo los registros que traen IMEI y coordenadas.
import * as XLSX from 'xlsx';
import { boundSheet, readWorkbook } from './xlsxSafe.js';
import { detectCsvDelimiter, findHeaderColumn, LATITUDE_HEADERS, LONGITUDE_HEADERS, parseCoordinateNumber, parseCsv } from './rutaService.js';
import { imeiCompleto } from './imeiUtils.js';
import { findContactColumns, lineKey } from '../public/js/planeacion-contactos.js';

const SSF = XLSX.SSF || XLSX.default?.SSF;
const HEADER_SEARCH_ROWS = 40;
// A mirror is logged with the clock of another zone: same second, or exactly one hour apart (Telcel, Sonora).
const MIRROR_OFFSETS = [3600, 0, -3600];
const MIRROR_SECONDS_TOLERANCE = 2;
const MIRROR_DURATION_TOLERANCE = 3;

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const pad2 = (value) => String(value).padStart(2, '0');

// The cell as the carrier wrote it. Long numbers (IMEI, lines) keep every digit: the formatted text of a 14-digit
// number in a "General" cell is 3.50291E+13. Date and time cells become dd/mm/aaaa and HH:MM:SS.
const cellText = (cell, date1904) => {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'n' && Number.isFinite(cell.v)) {
    if (cell.z && SSF.is_date(cell.z) && cell.v >= 0) {
      const parts = SSF.parse_date_code(cell.v, { date1904 });
      const time = `${pad2(parts.H)}:${pad2(parts.M)}:${pad2(Math.floor(parts.S))}`;
      const date = `${pad2(parts.d)}/${pad2(parts.m)}/${parts.y}`;
      const format = cell.z.replace(/"[^"]*"|\[[^\]]*\]/g, '');
      const hasDate = /[dy]/i.test(format);
      const hasTime = /[hs]/i.test(format);
      return !hasDate ? time : hasTime ? `${date} ${time}` : date;
    }
    return Number.isInteger(cell.v) ? cell.v.toFixed(0) : String(cell.v);
  }
  if (cell.t === 'b') return cell.v ? 'VERDADERO' : 'FALSO';
  return String(cell.v).trim();
};

const sheetRows = (worksheet, date1904) => {
  if (!worksheet?.['!ref']) return [];
  const range = XLSX.utils.decode_range(boundSheet(worksheet)['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) row.push(cellText(worksheet[XLSX.utils.encode_cell({ r, c })], date1904));
    while (row.length && row[row.length - 1] === '') row.pop();
    rows.push(row);
  }
  return rows;
};

// Every sheet of the workbook (or the CSV as one sheet), as text rows.
export function readSabanaSheets(buffer, extension) {
  if (extension === '.csv') {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    return [parseCsv(text, detectCsvDelimiter(text)).map((row) => row.map((cell) => String(cell ?? '').trim()))];
  }
  const workbook = readWorkbook(buffer, { type: 'buffer', cellDates: false, cellNF: true });
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
  return workbook.SheetNames.map((name) => sheetRows(workbook.Sheets[name], date1904));
}

const findColumn = (headers, test) => headers.findIndex((header) => test(header));

// Columns of a carrier's table, by header name. The type of record is the column whose values say VOZ, SMS, DATOS…
// when no header names it.
export function findSabanaColumns(headerRow, dataRows = []) {
  const headers = headerRow.map(fold);
  const { a, b } = findContactColumns(headerRow);
  const fecha = findColumn(headers, (h) => /^(fecha|date)\b/.test(h));
  const hora = findColumn(headers, (h) => /^(hora|time)\b/.test(h));
  const duracion = findColumn(headers, (h) => /^(dur|duracion|duration|segundos|tiempo)\b/.test(h) || h.startsWith('dur'));
  const imei = findColumn(headers, (h) => /^imei(?:[\W_]*(?:a|origen))?$/.test(h));
  let tipo = findColumn(headers, (h) => /^(tipo|servicio|evento|descripcion)\b/.test(h) || /^tipo[\W_]/.test(h));
  if (tipo < 0) {
    const sample = dataRows.slice(0, 200);
    tipo = headerRow.findIndex((_, column) => sample.length > 0
      && sample.filter((row) => /\b(voz|sms|mensaj\w*|datos|gprs|mms|llamada)\b/i.test(fold(row[column]))).length > sample.length / 2);
  }
  return {
    tipo, a, b, fecha, hora, duracion, imei,
    latitud: findHeaderColumn(headers, LATITUDE_HEADERS),
    longitud: findHeaderColumn(headers, LONGITUDE_HEADERS),
  };
}

// The table is the first sheet with a header naming Número A, Número B and a date; Telcel puts the holder's data
// above it, and that part is kept as it came.
export function findSabanaTable(sheets) {
  for (const rows of sheets) {
    for (let index = 0; index < Math.min(rows.length, HEADER_SEARCH_ROWS); index += 1) {
      const { a, b } = findContactColumns(rows[index] || []);
      const headers = (rows[index] || []).map(fold);
      if (a >= 0 && b >= 0 && headers.some((h) => /^(fecha|date)\b/.test(h))) return { rows, headerIndex: index };
    }
  }
  return null;
}

const parseDate = (text) => {
  const value = String(text ?? '').trim();
  let match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})/);
  if (match) return { y: Number(match[3].length === 2 ? `20${match[3]}` : match[3]), m: Number(match[2]), d: Number(match[1]) };
  match = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (match) return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  return null;
};

const parseTime = (text) => {
  const match = String(text ?? '').trim().match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]\.?\s?m\.?)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const meridiem = match[4]?.toLowerCase().replace(/[^ap]/g, '');
  if (meridiem === 'a' && hours === 12) hours = 0;
  if (meridiem === 'p' && hours < 12) hours += 12;
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
};

// Seconds since 1970 for comparing records; the date and the hour may be in one cell.
const timestampOf = (fechaText, horaText) => {
  const date = parseDate(fechaText);
  const time = horaText !== undefined ? parseTime(horaText) : parseTime(fechaText);
  if (!date || time === null) return null;
  return Date.UTC(date.y, date.m - 1, date.d) / 1000 + time;
};

// "57", "57.0" or "00:00:57".
const parseDuration = (text) => {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const clock = value.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) return clock[3] === undefined ? Number(clock[1]) * 60 + Number(clock[2]) : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) ? Math.round(number) : null;
};

export const recordKind = (tipo) => {
  const value = fold(tipo);
  if (/mensaj|\bsms\b|\bmms\b/.test(value)) return 'mensaje';
  if (/\bvoz\b|llamada|\bcall\b|voice/.test(value)) return 'voz';
  if (/datos|gprs|internet|\bdata\b|\blte\b|\bims\b/.test(value)) return 'datos';
  return 'otro';
};
const isTransit = (tipo) => /transito/.test(fold(tipo));

const hasCoordinates = (record, columns) => {
  if (columns.latitud < 0 || columns.longitud < 0) return false;
  const lat = parseCoordinateNumber(record.cells[columns.latitud]);
  const lng = parseCoordinateNumber(record.cells[columns.longitud]);
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
};

const formatTimestamp = (seconds) => {
  if (seconds === null) return '';
  const date = new Date(seconds * 1000);
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} `
    + `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
};

// Telcel's CSV puts both coordinates in one quoted LATITUD field ("29°05'00.00N,110°58'00.00W"), so the azimuth lands
// under LONGITUD and the Azimuth column stays empty. Such a row is put back in its columns; the dates written
// 2026/09/13 become 13/09/2026 like everywhere else in the app.
const SPLIT_COORDINATES = /^\s*([^,;]+?)\s*[,;]\s*([^,;]+?)\s*$/;
export function normalizeSabanaCells(cells, columns, width) {
  const row = cells.slice();
  if (columns.latitud >= 0 && columns.longitud === columns.latitud + 1) {
    const match = String(row[columns.latitud] ?? '').match(SPLIT_COORDINATES);
    const lat = match ? parseCoordinateNumber(match[1]) : null;
    const lng = match ? parseCoordinateNumber(match[2]) : null;
    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      row.splice(columns.latitud, 1, match[1], match[2]);
      while (row.length > width && String(row[row.length - 1] ?? '').trim() === '') row.pop();
    }
  }
  if (columns.fecha >= 0) {
    row[columns.fecha] = String(row[columns.fecha] ?? '').replace(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?=$|[ T])/,
      (_, y, m, d) => `${pad2(d)}/${pad2(m)}/${y}`);
  }
  return row;
}

// Separates the real records from the mirrors and counts what the summary sheet shows.
export function limpiarSabana(sheets) {
  const table = findSabanaTable(sheets);
  if (!table) throw new Error('No se encontró la tabla de la sábana: se necesitan las columnas Número A, Número B y Fecha.');
  const { rows, headerIndex } = table;
  const header = rows[headerIndex];
  const dataRows = rows.slice(headerIndex + 1);
  const columns = findSabanaColumns(header, dataRows);
  if (columns.tipo < 0) throw new Error('No se encontró la columna del tipo de registro (VOZ SALIENTE, VOZ TRANSITO…).');

  // Blank lines and legal footers (a single filled cell) are not records.
  const records = [];
  dataRows.forEach((sourceCells, offset) => {
    if (sourceCells.filter((cell) => String(cell ?? '').trim() !== '').length < 2) return;
    const cells = normalizeSabanaCells(sourceCells, columns, header.length);
    records.push({
      cells,
      rowNumber: headerIndex + offset + 2,
      tipo: String(cells[columns.tipo] ?? '').trim(),
      a: lineKey(cells[columns.a]),
      b: lineKey(cells[columns.b]),
      time: columns.fecha < 0 ? null : timestampOf(cells[columns.fecha], columns.hora >= 0 ? cells[columns.hora] : undefined),
      duration: columns.duracion >= 0 ? parseDuration(cells[columns.duracion]) : null,
    });
  });

  // Non-transit records by their own line and second, to find the original of each transit.
  const bySecond = new Map();
  for (const record of records) {
    if (isTransit(record.tipo) || record.time === null || !record.a) continue;
    const key = `${record.a}|${record.time}`;
    if (!bySecond.has(key)) bySecond.set(key, []);
    bySecond.get(key).push(record);
  }
  const sameDuration = (x, y) => columns.duracion < 0
    || (x.duration !== null && y.duration !== null && Math.abs(x.duration - y.duration) <= MIRROR_DURATION_TOLERANCE);
  const findOriginal = (transit, needSameB) => {
    for (const offset of MIRROR_OFFSETS) {
      for (let delta = 0; delta <= MIRROR_SECONDS_TOLERANCE; delta += 1) {
        for (const shift of delta === 0 ? [0] : [delta, -delta]) {
          const candidates = bySecond.get(`${transit.a}|${transit.time + offset + shift}`) || [];
          const match = candidates.find((candidate) => sameDuration(transit, candidate) && (!needSameB || candidate.b === transit.b));
          if (match) return { original: match, offset: offset + shift };
        }
      }
    }
    return null;
  };

  const reales = [];
  const espejos = [];
  for (const record of records) {
    const found = isTransit(record.tipo) && record.time !== null && record.a
      ? findOriginal(record, true) || findOriginal(record, false)
      : null;
    if (found) espejos.push({ record, original: found.original, offset: found.offset, sameB: found.original.b === record.b });
    else reales.push(record);
  }

  // Summary of the real records.
  const porTipo = new Map();
  const imeis = new Map();
  const conDuracion = columns.duracion >= 0;
  let completadas = 0;
  let noCompletadas = 0;
  let mensajes = 0;
  let datos = 0;
  let otros = 0;
  let imeiInvalidos = 0;
  let imeiCientifico = 0;
  let primero = null;
  let ultimo = null;
  const lineas = new Map();
  const geo = [];
  for (const record of reales) {
    const kind = recordKind(record.tipo);
    const tipo = record.tipo || '(sin tipo)';
    if (!porTipo.has(tipo)) porTipo.set(tipo, { tipo, registros: 0, completadas: 0, noCompletadas: 0, voz: kind === 'voz' });
    const entry = porTipo.get(tipo);
    entry.registros += 1;
    if (kind === 'voz') {
      if (conDuracion && record.duration !== null && record.duration > 0) { completadas += 1; entry.completadas += 1; }
      else if (conDuracion) { noCompletadas += 1; entry.noCompletadas += 1; }
    } else if (kind === 'mensaje') mensajes += 1;
    else if (kind === 'datos') datos += 1;
    else otros += 1;

    if (record.time !== null) {
      if (primero === null || record.time < primero) primero = record.time;
      if (ultimo === null || record.time > ultimo) ultimo = record.time;
    }
    for (const line of new Set([record.a, record.b])) if (line) lineas.set(line, (lineas.get(line) || 0) + 1);

    const rawImei = columns.imei >= 0 ? String(record.cells[columns.imei] ?? '').trim() : '';
    const imei = imeiCompleto(rawImei);
    if (imei) {
      if (!imeis.has(imei)) imeis.set(imei, { imei, registros: 0, primero: null, ultimo: null });
      const use = imeis.get(imei);
      use.registros += 1;
      if (record.time !== null) {
        if (use.primero === null || record.time < use.primero) use.primero = record.time;
        if (use.ultimo === null || record.time > use.ultimo) use.ultimo = record.time;
      }
      if (hasCoordinates(record, columns)) geo.push(record);
    } else if (rawImei) {
      imeiInvalidos += 1;
      if (/e\+?\d+$/i.test(rawImei)) imeiCientifico += 1;
    }
  }
  let linea = '';
  for (const [line, count] of lineas) if (count > (lineas.get(linea) || 0)) linea = line;

  return {
    preamble: rows.slice(0, headerIndex),
    header,
    columns,
    reales,
    espejos,
    geo,
    resumen: {
      linea,
      registrosOriginales: records.length,
      espejos: espejos.length,
      espejosBDistinto: espejos.filter((mirror) => !mirror.sameB).length,
      registrosReales: reales.length,
      conDuracion,
      llamadasCompletadas: completadas,
      llamadasNoCompletadas: noCompletadas,
      mensajes,
      datos,
      otros,
      imeiValidos: imeis.size,
      imeiInvalidos,
      imeiCientifico,
      registrosGeo: geo.length,
      sinColumnaUbicacion: columns.latitud < 0 || columns.longitud < 0,
      sinColumnaImei: columns.imei < 0,
      primero: formatTimestamp(primero),
      ultimo: formatTimestamp(ultimo),
      imeis: [...imeis.values()]
        .sort((x, y) => y.registros - x.registros || x.imei.localeCompare(y.imei))
        .map((use) => ({ ...use, primero: formatTimestamp(use.primero), ultimo: formatTimestamp(use.ultimo) })),
      porTipo: [...porTipo.values()].sort((x, y) => y.registros - x.registros || x.tipo.localeCompare(y.tipo)),
    },
  };
}

// Text cells keep long numbers and dates exactly as written; durations stay numbers so Excel can add them.
const sheetOf = (rows, numericColumns = []) => {
  const worksheet = XLSX.utils.aoa_to_sheet([]);
  let width = 0;
  const widths = [];
  rows.forEach((row, r) => {
    width = Math.max(width, row.length);
    row.forEach((value, c) => {
      if (value === undefined || value === null || value === '') return;
      const text = String(value);
      const numeric = typeof value === 'number' || (numericColumns.includes(c) && r > 0 && /^-?\d+$/.test(text));
      worksheet[XLSX.utils.encode_cell({ r, c })] = numeric ? { t: 'n', v: Number(value) } : { t: 's', v: text };
      widths[c] = Math.max(widths[c] || 8, Math.min(text.length + 2, 45));
    });
  });
  worksheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: Math.max(width - 1, 0) } });
  worksheet['!cols'] = Array.from({ length: width }, (_, c) => ({ wch: widths[c] || 8 }));
  return worksheet;
};

const offsetText = (seconds) => {
  const sign = seconds < 0 ? '−' : '+';
  const value = Math.abs(seconds);
  return `${sign}${pad2(Math.floor(value / 3600))}:${pad2(Math.floor((value % 3600) / 60))}:${pad2(value % 60)}`;
};

export function resumenRows(resumen, nombreArchivo) {
  const count = (value) => (resumen.conDuracion ? value : 'Sin columna de duración');
  const rows = [
    ['Resumen de la sábana'],
    [],
    ['Archivo', nombreArchivo],
    ['Línea', resumen.linea],
    ['Primer registro', resumen.primero],
    ['Último registro', resumen.ultimo],
    [],
    ['Registros en el archivo original', resumen.registrosOriginales],
    ['Llamadas espejo quitadas', resumen.espejos],
    ['Registros reales', resumen.registrosReales],
    [],
    ['Llamadas completadas', count(resumen.llamadasCompletadas)],
    ['Llamadas no completadas', count(resumen.llamadasNoCompletadas)],
    ['Mensajes', resumen.mensajes],
    ['Datos', resumen.datos],
    ...(resumen.otros ? [['Otros registros', resumen.otros]] : []),
    ['IMEI válidos', resumen.imeiValidos],
    ['Registros con IMEI y ubicación', resumen.registrosGeo],
  ];
  if (resumen.imeis.length) {
    rows.push([], ['IMEI', 'Registros', 'Primer uso', 'Último uso']);
    for (const use of resumen.imeis) rows.push([use.imei, use.registros, use.primero, use.ultimo]);
  }
  rows.push([], ['Tipo de registro', 'Registros', 'Completadas', 'No completadas']);
  for (const entry of resumen.porTipo) {
    rows.push([entry.tipo, entry.registros, entry.voz && resumen.conDuracion ? entry.completadas : '', entry.voz && resumen.conDuracion ? entry.noCompletadas : '']);
  }
  rows.push(
    [],
    ['Criterios'],
    ['Llamada espejo: registro VOZ TRANSITO de la misma línea A que coincide con otro registro a la misma hora o con exactamente 1 hora de diferencia (±2 s) y la misma duración (±3 s). Se conserva el registro original, que es el que trae la ubicación. La hoja "Espejos quitados" lista cada uno con su fila original.'],
    ['Llamada completada: registro de voz con duración mayor a 0 segundos. No completada: duración 0 o vacía.'],
    ['IMEI válido: 14 a 16 dígitos que no sean un mismo dígito repetido; se muestra con su dígito verificador (15 dígitos). Se cuentan IMEI distintos.'],
    ['Las horas se dejan como las entregó la compañía; los espejos indican que la compañía mezcla dos zonas horarias.'],
  );
  if (resumen.espejosBDistinto) {
    rows.push([`${resumen.espejosBDistinto} espejos tienen un número B distinto al de su llamada original (posible desvío o número de enrutamiento); revisar en "Espejos quitados".`]);
  }
  if (resumen.imeiInvalidos) {
    rows.push([`${resumen.imeiInvalidos} registros traen un IMEI no válido${resumen.imeiCientifico ? `, ${resumen.imeiCientifico} de ellos en notación científica (Excel ya perdió los dígitos; pide o sube el archivo original)` : ''}.`]);
  }
  if (resumen.sinColumnaImei) rows.push(['El archivo no trae columna IMEI.']);
  if (resumen.sinColumnaUbicacion) rows.push(['El archivo no trae columnas de latitud y longitud.']);
  return rows;
}

export function espejosRows(result) {
  const { columns, header } = result;
  const label = (column, fallback) => (column >= 0 ? String(header[column] || fallback) : fallback);
  const rows = [[
    'Fila original', label(columns.tipo, 'Tipo'), label(columns.a, 'Número A'), label(columns.b, 'Número B'),
    label(columns.fecha, 'Fecha'), ...(columns.hora >= 0 ? [label(columns.hora, 'Hora')] : []),
    ...(columns.duracion >= 0 ? [label(columns.duracion, 'Duración')] : []),
    'Fila del registro real', 'Tipo del registro real', 'Número B del registro real', 'Diferencia de hora', 'Observación',
  ]];
  for (const { record, original, offset, sameB } of result.espejos) {
    const cell = (column) => (column >= 0 ? record.cells[column] ?? '' : '');
    rows.push([
      record.rowNumber, cell(columns.tipo), cell(columns.a), cell(columns.b), cell(columns.fecha),
      ...(columns.hora >= 0 ? [cell(columns.hora)] : []),
      ...(columns.duracion >= 0 ? [record.duration ?? cell(columns.duracion)] : []),
      original.rowNumber, original.tipo, original.cells[columns.b] ?? '', offsetText(offset),
      sameB ? 'Misma llamada' : 'Número B distinto: posible desvío o enrutamiento',
    ]);
  }
  return rows;
}

const tableRows = (result, records) => [result.header, ...records.map((record) => record.cells)];

export function createSabanaLimpiaXlsx(result, nombreArchivo) {
  const workbook = XLSX.utils.book_new();
  const numeric = result.columns.duracion >= 0 ? [result.columns.duracion] : [];
  XLSX.utils.book_append_sheet(workbook, sheetOf([...result.preamble, ...tableRows(result, result.reales)], numeric), 'Sábana');
  XLSX.utils.book_append_sheet(workbook, sheetOf(resumenRows(result.resumen, nombreArchivo)), 'Resumen');
  XLSX.utils.book_append_sheet(workbook, sheetOf(espejosRows(result)), 'Espejos quitados');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// For Ruta: only the table, only records with a valid IMEI and coordinates, IMEI and lines as text.
export function createGeoposicionamientoXlsx(result) {
  const workbook = XLSX.utils.book_new();
  const numeric = result.columns.duracion >= 0 ? [result.columns.duracion] : [];
  XLSX.utils.book_append_sheet(workbook, sheetOf(tableRows(result, result.geo), numeric), 'Geoposicionamiento');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export function procesarSabana(buffer, extension, nombreArchivo) {
  const result = limpiarSabana(readSabanaSheets(buffer, extension));
  return {
    resumen: result.resumen,
    sabana: createSabanaLimpiaXlsx(result, nombreArchivo),
    geo: createGeoposicionamientoXlsx(result),
  };
}
