import test from 'node:test';
import assert from 'node:assert/strict';
import { contactosPorNumeros } from '../src/contactosArchivo.js';

const telcel = [
  ['Linea: 6624287887 con periodo de busqueda del 21/10/2026 al 24/10/2026'],
  ['Nombre:', 'ROBERTO AGUIRRE PRECIADO'],
  ['Telefono', 'Tipo', 'Numero A', 'Numero B', 'Fecha', 'Hora', 'IMEI', 'contactos'],
  ['6624287887', 'VOZ SALIENTE', '6624287887', '6621112233', '21/10/2026', '10:00', '359218656950851', 'ims'],
  ['6624287887', 'VOZ ENTRANTE', '526624445566', '6624287887', '21/10/2026', '11:00', '359218656950851', 'ims'],
  ['6624287887', 'DATOS', '6624287887', 'ims', '21/10/2026', '12:00', '359218656950851', 'ims'],
  ['6624287887', 'SMS', '6624287887', '6621112233', '22/10/2026', '09:00', '359218656950851', 'ims'],
];

test('contacts come from the side of each record that is not the typed line, one per record', () => {
  assert.deepEqual(contactosPorNumeros([telcel], '662 428 7887').contactos, ['6621112233', '6624445566', '6621112233']);
  // The 52 prefix and formatting of the typed line do not matter.
  assert.deepEqual(contactosPorNumeros([telcel], '+52 662 428 7887').contactos.length, 3);
});

test('other carriers name the columns origen and destino, and the right sheet is found', () => {
  const generic = [['MSISDN Origen', 'MSISDN Destino', 'Duración'], ['5512345678', '6624287887', '30'], ['6624287887', '5598765432', '12']];
  assert.deepEqual(contactosPorNumeros([[['Resumen']], generic], '6624287887').contactos, ['5512345678', '5598765432']);
});

test('a mistyped line is reported with the number the file repeats most', () => {
  const { contactos, error } = contactosPorNumeros([telcel], '6624287888');
  assert.deepEqual(contactos, []);
  assert.match(error, /6624287888 no aparece[\s\S]*6624287887/);
  assert.match(contactosPorNumeros([[['Fecha', 'Hora'], ['1', '2']]], '6624287887').error, /Número A y Número B/);
  assert.match(contactosPorNumeros([telcel], '').error, /Escribe la línea/);
});
