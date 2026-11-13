import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { readRutaXlsxRows } from '../src/rutaService.js';

// Invented records in the layout of a Movistar CDR split over several sheets.
const header = ['TIPO CDR', 'NUMERO A', 'NUMERO B', 'FECHA EVENTO', 'HORA EVENTO', 'LATITUD', 'LONGITUD'];
const fila = (n) => ['GSM', '6620000001', `66200000${String(n).padStart(2, '0')}`, '01/10/2026', `10:${String(n).padStart(2, '0')}:00`, '29.07', '-110.95'];
const libro = (hojas) => {
  const workbook = XLSX.utils.book_new();
  hojas.forEach(([nombre, filas]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(filas), nombre));
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

test('every sheet of a split record is read: repeated header or plain continuation', () => {
  const rows = readRutaXlsxRows(libro([
    ['Hoja1', [header, fila(1), fila(2)]],
    ['Hoja2', [header, fila(3)]],
    ['Hoja3', [fila(4), fila(5)]],
  ]));
  assert.deepEqual(rows[0], header);
  assert.deepEqual(rows.slice(1).map((row) => row[2]), ['6620000001', '6620000002', '6620000003', '6620000004', '6620000005']);
});

test('a sheet with another table is skipped', () => {
  const rows = readRutaXlsxRows(libro([
    ['Datos', [header, fila(1)]],
    ['Resumen', [['Total', '1']]],
    ['Otra tabla', [['Nombre', 'NUMERO A', 'X', 'Y', 'Z', 'W', 'V'], ['a', 'b', 'c', 'd', 'e', 'f', 'g']]],
  ]));
  assert.equal(rows.length, 2);
});

test('a single sheet reads as before', () => {
  const rows = readRutaXlsxRows(libro([['Hoja1', [header, fila(1)]]]));
  assert.deepEqual(rows, [header, fila(1)]);
});
