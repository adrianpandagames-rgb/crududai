import { findContactColumns, lineKey } from './planeacion-contactos.js?v=1';

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Column of the kind of communication ("Tipo", "Servicio", "Tipo de evento", "Call type"…), of its duration and of
// its result. Columns about the antenna, the device or the technology are not the kind of communication.
const TYPE = /(^|[\W_])(tipo|servicio|evento|service|type)([\W_]|$)/;
const NOT_TYPE = /antena|antenna|tecnologia|technology|equipo|imei|imsi|celda|cell|red|network/;
const DURATION = /duracion|duration|^dur([\W_]|$)|segundos|seconds/;
const STATUS = /estatus|status|estado|resultado|result/;

export function findCommunicationColumns(headers) {
  const folded = headers.map(fold);
  return {
    type: folded.findIndex((header) => TYPE.test(header) && !NOT_TYPE.test(header)),
    duration: folded.findIndex((header) => DURATION.test(header)),
    status: folded.findIndex((header) => STATUS.test(header)),
  };
}

// Seconds from "83", "83.5", "1:23" or "00:01:23"; null when the cell says nothing.
export function parseDuration(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.includes(':')) {
    const parts = text.split(':').map(Number);
    return parts.some(Number.isNaN) ? null : parts.reduce((total, part) => total * 60 + part, 0);
  }
  const seconds = Number(text.replace(',', '.'));
  return Number.isFinite(seconds) ? seconds : null;
}

const SMS = /sms|mms|mensaj|\bmsg\b/;
const VOICE = /voz|llamada|\bcall|voice|volte|\bmoc\b|\bmtc\b|desvio/;
const DATA = /dato|gprs|internet|\bdata\b|navegac|\bpdp\b|\bps\b|\bims\b/;
const FAILED = /no contest|fallid|rechaz|ocupad|perdid|cancel|failed|busy|no answer|unanswered|missed/;

// 'call' (completed call), 'data', 'sms', or '' when the record is none of them or cannot be told apart.
export function classifyCommunication(row, columns) {
  const kind = columns.type >= 0 ? fold(row[columns.type]) : '';
  const seconds = columns.duration >= 0 ? parseDuration(row[columns.duration]) : null;
  const failed = columns.status >= 0 && FAILED.test(fold(row[columns.status]));
  if (SMS.test(kind)) return 'sms';
  if (VOICE.test(kind)) return !failed && (columns.duration < 0 || (seconds ?? 0) > 0) ? 'call' : '';
  if (DATA.test(kind)) return 'data';
  // Without a recognisable kind, a record whose B side is text ("internet", "ims") or empty while A is the line
  // is a data session.
  if (!kind && columns.b >= 0 && columns.a >= 0 && lineKey(row[columns.a]) && !lineKey(row[columns.b])) return 'data';
  return '';
}

export const COMMUNICATION_KINDS = [
  { kind: 'call', label: 'Llamada completada', short: 'Llamada' },
  { kind: 'data', label: 'Uso de datos', short: 'Datos' },
  { kind: 'sms', label: 'Mensajería SMS', short: 'SMS' },
];

// The latest record of each kind, by date and time, among the rows `include(rowNumber)` accepts (the period filter).
// Records without a readable date and time cannot be the latest and are only counted.
export function findLastCommunications(data, include = () => true) {
  const columns = { ...findCommunicationColumns(data.headers), ...findContactColumns(data.headers) };
  const result = { columns, hasType: columns.type >= 0 };
  for (const { kind } of COMMUNICATION_KINDS) result[kind] = { count: 0, row: null, time: '' };
  data.rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (!include(rowNumber)) return;
    const kind = classifyCommunication(row, columns);
    if (!kind) return;
    const entry = result[kind];
    entry.count++;
    // The seconds break ties within a minute; equal times keep the later row of the file.
    const time = data.times?.[rowNumber] && data.clocks?.[rowNumber]
      ? `${data.times[rowNumber].slice(0, 10)}T${data.clocks[rowNumber]}` : data.times?.[rowNumber];
    if (time && time >= entry.time) Object.assign(entry, { row: rowNumber, time });
  });
  return result;
}

// The columns of the report table the "Copiar" button fills, in its order.
export const LAST_COMMUNICATION_HEADERS = [
  'Tipo de comunicación', 'Número emisor', 'Número receptor', 'Fecha', 'Hora', 'Duración en segundos',
  'Ubicación de la antena', 'Lugar',
];
const INCOMING = /entrante|recibid|incoming|\bmt\b|terminad/;

// One report row for record `rowNumber`. `columns` is findLastCommunications().columns; `location` and `place` are
// the indexes of the Ubicación and Lugar columns; `target` is the line of the file (lineKey) when known.
// Carriers that keep the target in Número A for every record mark the incoming ones only by their type, so an
// incoming record with the target in A has its sides swapped to name who sent it.
export function lastCommunicationCells(data, rowNumber, columns, { label = '', location = -1, place = -1, target = '' } = {}) {
  const row = data.rows[rowNumber - 1] || [];
  const cell = (column) => (column >= 0 ? String(row[column] ?? '').replace(/[\t\r\n]+/g, ' ').trim() : '');
  const type = cell(columns.type);
  let [sender, receiver] = [cell(columns.a), cell(columns.b)];
  if (INCOMING.test(fold(type)) && target && lineKey(sender) === target && lineKey(receiver) !== target) {
    [sender, receiver] = [receiver, sender];
  }
  const [, year, month, day, minute = ''] = String(data.times?.[rowNumber] || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(.*))?$/) || [];
  const time = data.clocks?.[rowNumber] || minute;
  const seconds = columns.duration >= 0 ? parseDuration(row[columns.duration]) : null;
  return [
    type || label, sender, receiver, year ? `${day}/${month}/${year}` : '', time,
    seconds === null ? cell(columns.duration) : String(seconds), cell(location), cell(place),
  ];
}

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tab-separated text and an HTML table (Excel pastes it cell by cell) for one or more report rows.
export function lastCommunicationClipboard(rowsOfCells) {
  return {
    text: rowsOfCells.map((cells) => cells.join('\t')).join('\n'),
    html: `<table>${rowsOfCells.map((cells) => `<tr>${cells.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</table>`,
  };
}
