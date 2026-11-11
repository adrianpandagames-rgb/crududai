import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCommunicationColumns, parseDuration, classifyCommunication, findLastCommunications,
  LAST_COMMUNICATION_HEADERS, lastCommunicationCells, lastCommunicationClipboard,
} from '../public/js/planeacion-ultima.js';

// Invented records only.
const headers = ['Telefono', 'Tipo', 'Numero A', 'Numero B', 'Duracion', 'Fecha', 'Hora', 'Tipo de antena'];
const rows = [
  ['6620000001', 'VOZ SALIENTE', '6620000001', '6620000002', '00:01:10', '01/10/2026', '10:00:00', 'Macro'],
  ['6620000001', 'VOZ ENTRANTE', '6620000003', '6620000001', '0', '03/10/2026', '11:00:00', 'Macro'],
  ['6620000001', 'SMS', '6620000001', '6620000002', '', '02/10/2026', '09:00:00', 'Macro'],
  ['6620000001', 'DATOS', '6620000001', 'internet', '', '02/10/2026', '12:00:00', 'Macro'],
  ['6620000001', 'DATOS', '6620000001', 'internet', '', '01/10/2026', '07:00:00', 'Macro'],
  ['6620000001', 'VOZ ENTRANTE', '6620000004', '6620000001', '45', '02/10/2026', '18:00:00', 'Macro'],
];
const times = {
  1: '2026-10-01T10:00', 2: '2026-10-03T11:00', 3: '2026-10-02T09:00', 4: '2026-10-02T12:00', 5: '2026-10-01T07:00', 6: '2026-10-02T18:00',
};

test('the type, duration and result columns are found, never the antenna type', () => {
  assert.deepEqual(findCommunicationColumns(headers), { type: 1, duration: 4, status: -1 });
  assert.deepEqual(findCommunicationColumns(['Tipo de antena', 'Servicio', 'Estatus']), { type: 1, duration: -1, status: 2 });
});

test('durations are read as seconds', () => {
  assert.equal(parseDuration('00:01:10'), 70);
  assert.equal(parseDuration('1:05'), 65);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('2,5'), 2.5);
  assert.equal(parseDuration(''), null);
});

test('calls with no duration or a failed result are not completed calls', () => {
  const columns = { type: 0, duration: 1, status: 2, a: -1, b: -1 };
  assert.equal(classifyCommunication(['VOZ', '30', 'Contestada'], columns), 'call');
  assert.equal(classifyCommunication(['VOZ', '0', 'Contestada'], columns), '');
  assert.equal(classifyCommunication(['VOZ', '30', 'No contestada'], columns), '');
  assert.equal(classifyCommunication(['MENSAJE 2 VIAS', '', ''], columns), 'sms');
  assert.equal(classifyCommunication(['GPRS', '', ''], columns), 'data');
  assert.equal(classifyCommunication(['VOLTE', '12', ''], columns), 'call');
  // Without a duration column every call counts as completed.
  assert.equal(classifyCommunication(['VOZ'], { type: 0, duration: -1, status: -1, a: -1, b: -1 }), 'call');
});

test('Telcel types: voice in both directions, data and messages in both directions', () => {
  const columns = { type: 0, duration: 1, status: -1, a: -1, b: -1 };
  assert.equal(classifyCommunication(['VOZ SALIENTE', '00:00:35'], columns), 'call');
  assert.equal(classifyCommunication(['VOZ ENTRANTE', '12'], columns), 'call');
  assert.equal(classifyCommunication(['VOZ ENTRANTE', '0'], columns), '');
  assert.equal(classifyCommunication(['DATOS', ''], columns), 'data');
  assert.equal(classifyCommunication(['MENSAJE ENTRANTE', ''], columns), 'sms');
  assert.equal(classifyCommunication(['MENSAJE SALIENTE', ''], columns), 'sms');
});

test('without a type column a record whose B side is not a line is data', () => {
  const columns = { type: -1, duration: -1, status: -1, a: 0, b: 1 };
  assert.equal(classifyCommunication(['6620000001', 'ims'], columns), 'data');
  assert.equal(classifyCommunication(['6620000001', '6620000002'], columns), '');
});

test('the latest record of each kind is chosen by date and time, within the period', () => {
  const last = findLastCommunications({ headers, rows, times });
  assert.deepEqual(last.call, { count: 2, row: 6, time: '2026-10-02T18:00' });
  assert.deepEqual(last.data, { count: 2, row: 4, time: '2026-10-02T12:00' });
  assert.deepEqual(last.sms, { count: 1, row: 3, time: '2026-10-02T09:00' });
  const early = findLastCommunications({ headers, rows, times }, (row) => times[row] < '2026-10-02');
  assert.deepEqual(early.call, { count: 1, row: 1, time: '2026-10-01T10:00' });
  assert.deepEqual(early.data, { count: 1, row: 5, time: '2026-10-01T07:00' });
  assert.deepEqual(early.sms, { count: 0, row: null, time: '' });
});

test('a last communication is copied in the columns of the report table', () => {
  const data = { headers: [...headers, 'Ubicacion', 'Lugar'], rows: rows.map((row) => [...row, 'Calle Inventada 1', 'Hermosillo']), times };
  const { columns } = findLastCommunications(data);
  const options = { location: 8, place: 9, target: '6620000001' };
  assert.deepEqual(LAST_COMMUNICATION_HEADERS.length, 8);
  assert.deepEqual(lastCommunicationCells(data, 1, columns, options),
    ['VOZ SALIENTE', '6620000001', '6620000002', '01/10/2026', '10:00', '70', 'Calle Inventada 1', 'Hermosillo']);
  // The file already puts the caller in A: nothing is swapped.
  assert.deepEqual(lastCommunicationCells(data, 6, columns, options).slice(0, 3), ['VOZ ENTRANTE', '6620000004', '6620000001']);
  assert.deepEqual(lastCommunicationCells(data, 4, columns, options).slice(1, 3), ['6620000001', 'internet']);
});

test('an incoming record with the target in Número A names the other line as sender', () => {
  const data = { headers, rows: [['6620000001', 'SMS ENTRANTE', '6620000001', '6620000009', '', '05/10/2026', '08:30:00', 'Macro']],
    times: { 1: '2026-10-05T08:30:00' } };
  const { columns } = findLastCommunications(data);
  const cells = lastCommunicationCells(data, 1, columns, { label: 'Mensajería SMS', target: '6620000001' });
  assert.deepEqual(cells, ['SMS ENTRANTE', '6620000009', '6620000001', '05/10/2026', '08:30:00', '', '', '']);
});

test('several rows are copied as text and as an escaped HTML table', () => {
  const { text, html } = lastCommunicationClipboard([['VOZ', 'a<b'], ['SMS', 'c']]);
  assert.equal(text, 'VOZ\ta<b\nSMS\tc');
  assert.equal(html, '<table><tr><td>VOZ</td><td>a&lt;b</td></tr><tr><td>SMS</td><td>c</td></tr></table>');
});

test('the copied hour keeps the seconds and they break ties within a minute', () => {
  const data = {
    headers: ['Tipo', 'Numero A', 'Numero B', 'Duracion'],
    rows: [['VOZ SALIENTE', '6620000001', '6620000002', '30'], ['SMS', '6620000001', '6620000002', '']],
    times: { 1: '2026-10-05T08:30', 2: '2026-10-05T08:30' },
    clocks: { 1: '08:30:45', 2: '08:30:10' },
  };
  const result = findLastCommunications(data);
  assert.equal(result.call.time, '2026-10-05T08:30:45');
  assert.equal(result.sms.time, '2026-10-05T08:30:10');
  assert.deepEqual(lastCommunicationCells(data, 1, result.columns).slice(3, 6), ['05/10/2026', '08:30:45', '30']);
});
