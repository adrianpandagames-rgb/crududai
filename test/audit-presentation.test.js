import test from 'node:test';
import assert from 'node:assert/strict';
import { presentAuditEntry } from '../src/auditPresentation.js';

test('audit displays search, filters, identity, day and time without expanding details', () => {
  const entry = presentAuditEntry({ user_email: 'usuario@example.com', operation: 'SEARCH',
    request_path: '/imei', createdAt: '2026-10-17 14:35:22',
    details: JSON.stringify({ parametros: { search: '123456789', lugar: 'Centro', page: '2', token: 'privado' } }),
  });
  assert.equal(entry.day, '2026-10-17');
  assert.equal(entry.time, '14:35:22');
  assert.equal(entry.user_email, 'usuario@example.com');
  assert.equal(entry.searched, 'search: 123456789 · lugar: Centro');
  assert.equal(entry.details.parametros.token, '[OCULTO]');
});

test('old search URLs and telephone POST bodies are supported', () => {
  assert.equal(presentAuditEntry({ request_path: '/Crud?search=6621234567', operation: 'SEARCH' }).searched, 'search: 6621234567');
  assert.equal(presentAuditEntry({ details: { datos: { numero: '6621234567' } } }).searched, 'numero: 6621234567');
  assert.equal(presentAuditEntry({ details: 'invalid json', operation: 'SEARCH' }).searched, 'Sin término registrado');
});
