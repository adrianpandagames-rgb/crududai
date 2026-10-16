import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditDetails } from '../src/auditDetails.js';

test('audit preserves submitted fields and hides nested credentials', () => {
  assert.deepEqual(buildAuditDetails({ body: {
    nombre: 'Registro', numero: '123', password: 'secret',
    filas: [{ nuc: '456', api_key: 'secret' }],
  }, query: { token: 'secret', tipo: 'Recepción' } }), {
    datos: { nombre: 'Registro', numero: '123', password: '[OCULTO]', filas: [{ nuc: '456', api_key: '[OCULTO]' }] },
    parametros: { token: '[OCULTO]', tipo: 'Recepción' },
  });
});

test('multipart audit captures fields and file metadata without file contents', () => {
  assert.deepEqual(buildAuditDetails({ body: { nuc: '123' }, files: {
    adjuntos: [{ fieldname: 'adjuntos', originalname: 'datos.csv', mimetype: 'text/csv', size: 42, buffer: Buffer.from('contenido') }],
  } }), {
    datos: { nuc: '123' }, archivos: [{ campo: 'adjuntos', nombre: 'datos.csv', tipo: 'text/csv', bytes: 42 }],
  });
  assert.equal(buildAuditDetails({}), null);
});
