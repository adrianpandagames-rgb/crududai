import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLuhnCheckDigit, imeiCompleto, imeisDeArchivo, MAX_IMEIS_POR_ARCHIVO } from '../src/imeiUtils.js';

test('every way a carrier writes one phone becomes the same 15-digit IMEI', () => {
  assert.equal(calculateLuhnCheckDigit('49015420323751'), '8');
  for (const written of ['49015420323751', '490154203237518', '490154203237510', '4901542032375199', '49-015420-323751-0']) {
    assert.equal(imeiCompleto(written), '490154203237518');
  }
  assert.equal(imeiCompleto('4901542032375'), '');
  assert.equal(imeiCompleto('00000000000000'), '');
  assert.equal(imeiCompleto('ims'), '');
});

test('the target IMEIs of a sábana are read below the holder data, once each', () => {
  const telcel = [
    ['Linea: 6624287887 con periodo de busqueda del 21/10/2026 al 24/10/2026'],
    ['Telefono', 'Numero A', 'Numero B', 'IMEI', 'IMEI B'],
    ['6624287887', '6624287887', '6621112233', '490154203237510', '351234567890120'],
    ['6624287887', '6621112233', '6624287887', '490154203237518', '351234567890120'],
    ['6624287887', '6624287887', 'ims', '35921865695085', ''],
    ['6624287887', '6624287887', '6621112233', '', ''],
  ];
  assert.deepEqual(imeisDeArchivo([telcel]), { imeis: ['490154203237518', '359218656950859'], demasiados: false });
  assert.deepEqual(imeisDeArchivo([[['Numero A', 'Numero B'], ['1', '2']]]), { imeis: [], demasiados: false });
});

test('a column with too many IMEIs is not taken', () => {
  const rows = [['IMEI'], ...Array.from({ length: MAX_IMEIS_POR_ARCHIVO + 1 }, (_, index) => [String(35000000000000 + index)])];
  assert.deepEqual(imeisDeArchivo([rows]), { imeis: [], demasiados: true });
});
