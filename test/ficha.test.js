import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretarBusqueda } from '../src/fichaService.js';

test('ten digits or more, as typed for a phone, is a line', () => {
  assert.deepEqual(interpretarBusqueda('662 123 4567'), { tipo: 'linea', numero: '6621234567' });
  assert.deepEqual(interpretarBusqueda('+52 (662) 123-4567'), { tipo: 'linea', numero: '6621234567' });
});

test('anything else is a NUC, offered as a line too when it could be one', () => {
  assert.deepEqual(interpretarBusqueda('12345'), { tipo: 'nuc', nuc: '12345', numero: null });
  assert.deepEqual(interpretarBusqueda(' 1234567 '), { tipo: 'nuc', nuc: '1234567', numero: '1234567' });
  assert.deepEqual(interpretarBusqueda('SON/HER/2026/123'), { tipo: 'nuc', nuc: 'SON/HER/2026/123', numero: null });
  assert.deepEqual(interpretarBusqueda('   '), { tipo: 'vacia' });
  assert.equal(interpretarBusqueda('x'.repeat(100)).nuc.length, 60);
});
