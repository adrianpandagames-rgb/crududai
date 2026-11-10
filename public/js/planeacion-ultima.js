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
    const time = data.times?.[rowNumber];
    // Ties keep the later row of the file.
    if (time && time >= entry.time) Object.assign(entry, { row: rowNumber, time });
  });
  return result;
}
