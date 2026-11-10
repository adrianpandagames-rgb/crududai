import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCommunicationColumns, parseDuration, classifyCommunication, findLastCommunications,
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
