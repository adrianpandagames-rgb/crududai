import test from 'node:test';
import assert from 'node:assert/strict';
import { findContactColumns, lineKey, summarizeContacts, contactsCsv } from '../public/js/planeacion-contactos.js';

const headers = ['Telefono', 'Tipo', 'Numero A', 'Numero B', 'Fecha', 'Hora'];

test('A and B columns are found under the names carriers use', () => {
  assert.deepEqual(findContactColumns(headers), { a: 2, b: 3 });
  assert.deepEqual(findContactColumns(['Línea A', 'Línea_B']), { a: 0, b: 1 });
  assert.deepEqual(findContactColumns(['Teléfono origen', 'Teléfono destino']), { a: 0, b: 1 });
  assert.deepEqual(findContactColumns(['Telefono', 'Antena']), { a: -1, b: -1 });
});

test('lines compare on their last ten digits and text such as "ims" is not a line', () => {
  assert.equal(lineKey('+52 1 662 123 4567'), '6621234567');
  for (const prefixed of ['526621234567', '5216621234567', '00526621234567', '520446621234567']) {
    assert.equal(lineKey(prefixed), '6621234567');
  }
  assert.equal(lineKey('ims'), '');
  assert.equal(lineKey('*264'), '264');
});

test('the typed line is the target: the other side is the contact, with its direction and dates', () => {
  const summary = summarizeContacts({
    headers, line: '662 123 4567',
    rows: [
      ['6621234567', 'VOZ', '6621234567', '6629990000', '01/10/2026', '10:00:00'],
      ['6621234567', 'SMS', '526629990000', '6621234567', '03/10/2026', '09:00:00'],
      ['6621234567', 'VOZ', '6621234567', '6625550000', '02/10/2026', '08:00:00'],
      ['6621234567', 'DATOS', '6621234567', 'ims', '02/10/2026', '08:30:00'],
    ],
    times: { 1: '2026-10-01T10:00', 2: '2026-10-03T09:00', 3: '2026-10-02T08:00', 4: '2026-10-02T08:30' },
  });
  assert.equal(summary.target, '6621234567');
  assert.equal(summary.detected, false);
  assert.equal(summary.withoutContact, 1);
  assert.deepEqual(summary.contacts[0], {
    line: '6629990000', total: 2, outgoing: 1, incoming: 1, rows: [1, 2], first: '2026-10-01T10:00', last: '2026-10-03T09:00',
  });
  assert.equal(summary.contacts[1].line, '6625550000');
  assert.match(contactsCsv(summary), /"6621234567","6629990000","2","66.67%","1","1","01\/10\/2026 10:00","03\/10\/2026 09:00"/);
});

test('when the typed line is not in the file, the most frequent number is taken as the target', () => {
  const summary = summarizeContacts({
    headers, line: '0000000000',
    rows: [
      ['', 'VOZ', '6620000001', '6620000002', '', ''],
      ['', 'VOZ', '6620000003', '6620000001', '', ''],
      ['', 'VOZ', '6620000001', '6620000002', '', ''],
    ],
  });
  assert.equal(summary.target, '6620000001');
  assert.equal(summary.detected, true);
  assert.deepEqual(summary.contacts.map((contact) => [contact.line, contact.total]), [['6620000002', 2], ['6620000003', 1]]);
});

test('the period filter limits the count but not the choice of target', () => {
  const data = { headers, line: '6620000001', rows: [['', '', '6620000001', '6620000002', '', ''], ['', '', '6620000002', '6620000001', '', '']] };
  const summary = summarizeContacts(data, (row) => row === 2);
  assert.deepEqual(summary.contacts.map((contact) => [contact.total, contact.incoming]), [[1, 1]]);
  assert.equal(summarizeContacts({ headers: ['Antena'], rows: [], line: '' }), null);
});
