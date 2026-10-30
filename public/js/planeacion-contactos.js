const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// "Numero A", "Línea_B", "Teléfono origen", "MSISDN destino", "B"…; a bare "Telefono" column is the target's own line.
const SIDE_A = /^(?:(?:numero|num|no|linea|telefono|tel|msisdn)[\W_]*)?(?:a|origen|origin|llamante|calling)$/;
const SIDE_B = /^(?:(?:numero|num|no|linea|telefono|tel|msisdn)[\W_]*)?(?:b|destino|destination|llamado|called)$/;

// Digits only, keeping the last ten so 52/521 prefixes match the national number. Anything with fewer than
// three digits ("ims", "internet", blank) is not a line.
export function lineKey(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length < 3 ? '' : digits.slice(-10);
}

export function findContactColumns(headers) {
  const folded = headers.map((header) => fold(header).replace(/\s+/g, ' '));
  return { a: folded.findIndex((header) => SIDE_A.test(header)), b: folded.findIndex((header) => SIDE_B.test(header)) };
}

// The target is the line the user typed when it appears in A or B; otherwise the number most present on either side,
// since every record of a carrier's CDR involves the requested line.
function findTarget(rows, a, b, typedLine) {
  const typed = lineKey(typedLine);
  const counts = new Map();
  for (const row of rows) {
    for (const key of new Set([lineKey(row[a]), lineKey(row[b])])) {
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  if (typed && counts.has(typed)) return { target: typed, detected: false };
  let target = '';
  for (const [key, count] of counts) if (count > (counts.get(target) || 0)) target = key;
  return { target, detected: Boolean(target) };
}

// `include(rowNumber)` limits the count (the period filter); the target is always chosen from the whole file.
export function summarizeContacts(data, include = () => true) {
  const { a, b } = findContactColumns(data.headers);
  if (a < 0 || b < 0) return null;
  const { target, detected } = findTarget(data.rows, a, b, data.line);
  const contacts = new Map();
  let withoutContact = 0;
  data.rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (!include(rowNumber)) return;
    const keyA = lineKey(row[a]);
    const keyB = lineKey(row[b]);
    let contact;
    let outgoing;
    if (keyA === target && keyB && keyB !== target) [contact, outgoing] = [keyB, true];
    else if (keyB === target && keyA && keyA !== target) [contact, outgoing] = [keyA, false];
    else {
      withoutContact++;
      return;
    }
    if (!contacts.has(contact)) contacts.set(contact, { line: contact, total: 0, outgoing: 0, incoming: 0, rows: [], first: '', last: '' });
    const entry = contacts.get(contact);
    entry.total++;
    entry[outgoing ? 'outgoing' : 'incoming']++;
    entry.rows.push(rowNumber);
    const time = data.times?.[rowNumber];
    if (time && (!entry.first || time < entry.first)) entry.first = time;
    if (time && (!entry.last || time > entry.last)) entry.last = time;
  });
  const list = [...contacts.values()].sort((x, y) => y.total - x.total || x.line.localeCompare(y.line));
  return { target, detected, typed: lineKey(data.line), contacts: list, withoutContact };
}

export const formatContactTime = (time) => (time ? time.replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$3/$2/$1 ') : '');

// Line, records, share, outgoing, incoming, first and last contact, as pasted into the report.
export function contactCells(contact, totalRecords) {
  const percentage = totalRecords > 0 ? contact.total / totalRecords * 100 : 0;
  return [contact.line, contact.total, `${percentage.toFixed(2)}%`, contact.outgoing, contact.incoming,
    formatContactTime(contact.first), formatContactTime(contact.last)].map(String);
}

export const CONTACT_HEADERS = ['Contacto', 'Registros', 'Porcentaje', 'Salientes', 'Entrantes', 'Primer contacto', 'Último contacto'];

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

export function contactsCsv(summary) {
  const total = summary.contacts.reduce((sum, contact) => sum + contact.total, 0);
  const lines = [['Objetivo', ...CONTACT_HEADERS], ...summary.contacts.map((contact) => [summary.target, ...contactCells(contact, total)])];
  return `﻿${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
