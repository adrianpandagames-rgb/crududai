import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { limpiarSabana, procesarSabana, readSabanaSheets } from '../src/limpiezaService.js';
import { readRutaXlsxRows } from '../src/rutaService.js';

const HEADER = ['Telefono', 'Tipo', 'Numero A', 'Numero B', 'Fecha', 'Hora', 'Duracion', 'IMEI', 'LATITUD', 'LONGITUD', 'Azimuth'];
const T = '6620000001';
const IMEI = 35290011223344; // 14 digits as Excel stores them: a number
const LAT = "29°05'00.00N";
const LNG = "110°58'00.00W";

// Invented rows laid out like a Telcel sábana: mirrors one hour before, with the same B or a forwarded B.
const DATA = [
  [T, 'VOZ TRANSITO', T, '5260000003', '13/09/2026', '11:36:10', 1025, '', '', '', ''], // 0 h, B distinto
  [T, 'VOZ SALIENTE', T, '6390000004', '13/09/2026', '11:36:10', 1025, IMEI, LAT, LNG, 210],
  [T, 'VOZ TRANSITO', T, '6620000002', '14/09/2026', '07:03:57', 59, '', '', '', ''], // +1 h
  [T, 'VOZ SALIENTE', T, '6620000002', '14/09/2026', '08:03:57', 57, IMEI, LAT, LNG, 150],
  [T, 'VOZ TRANSITO', T, '6620000005', '17/09/2026', '13:09:26', 14, '', '', '', ''], // two legs, one call
  [T, 'VOZ TRANSITO', T, '6620000006', '17/09/2026', '13:09:26', 14, '', '', '', ''],
  [T, 'VOZ SALIENTE', T, '6620000005', '17/09/2026', '14:09:26', 13, IMEI, LAT, LNG, 150],
  [T, 'VOZ TRANSITO', T, '19150000007', '17/09/2026', '23:30:30', 7, '', '', '', ''], // 1 + 10 digits, crosses midnight
  [T, 'VOZ SALIENTE', T, '9150000007', '18/09/2026', '00:30:31', 6, IMEI, '', '', ''],
  [T, 'VOZ TRANSITO', T, '6620000008', '18/09/2026', '19:21:29', 301, '', '', '', ''], // no original: kept
  [T, 'VOZ ENTRANTE', '6620000008', T, '18/09/2026', '20:21:29', 301, IMEI, LAT, LNG, 130], // other A: not its original
  [T, 'VOZ SALIENTE', T, '6390000004', '17/09/2026', '06:28:29', 0, IMEI, LAT, LNG, 130], // not completed
  [T, 'MENSAJES 2 VIAS SAL', T, '6621112233', '18/09/2026', '09:00:00', 0, IMEI, LAT, LNG, 130],
  [T, 'DATOS', T, 'ims', '18/09/2026', '09:05:00', 0, '3.5029E+13', LAT, LNG, 130], // IMEI ruined by Excel
];

const xlsxOf = (rows) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Hoja1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};
const sheetsOf = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return Object.fromEntries(workbook.SheetNames.map((name) => [name, XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' })]));
};
const telcel = () => xlsxOf([
  ['Linea: 6620000001 con periodo de busqueda del 13/09/2026 al 18/09/2026'],
  ['Nombre:', 'JUAN PEREZ'],
  HEADER,
  ...DATA,
  ['Información confidencial'],
]);

test('long numbers keep every digit when the sábana is read', () => {
  const [rows] = readSabanaSheets(telcel(), '.xlsx');
  assert.equal(rows[4][7], '35290011223344');
  assert.equal(rows[2][0], 'Telefono');
});

test('mirrors are the transit copies of a call: same second or one hour apart, same duration', () => {
  const result = limpiarSabana(readSabanaSheets(telcel(), '.xlsx'));
  const mirrorRows = result.espejos.map(({ record, original, sameB }) => [record.rowNumber, original.rowNumber, sameB]);
  // Sheet rows: preamble 1–2, header 3, data from 4.
  assert.deepEqual(mirrorRows, [[4, 5, false], [6, 7, true], [8, 10, true], [9, 10, false], [11, 12, true]]);
  assert.equal(result.reales.length, DATA.length - 5);
  assert.ok(result.reales.some((record) => record.rowNumber === 13), 'a transit without its original stays');
  assert.equal(result.resumen.espejosBDistinto, 2);
});

test('the summary counts the real records only', () => {
  const { resumen } = limpiarSabana(readSabanaSheets(telcel(), '.xlsx'));
  assert.equal(resumen.linea, T);
  assert.equal(resumen.registrosOriginales, 14);
  assert.equal(resumen.registrosReales, 9);
  // Salientes 1025, 57, 13, 6 s, the unmatched transit 301 s and the entrante 301 s; one saliente of 0 s.
  assert.equal(resumen.llamadasCompletadas, 6);
  assert.equal(resumen.llamadasNoCompletadas, 1);
  assert.equal(resumen.mensajes, 1);
  assert.equal(resumen.datos, 1);
  assert.equal(resumen.imeiValidos, 1);
  assert.match(resumen.imeis[0].imei, /^35290011223344\d$/, 'completed with its check digit');
  assert.equal(resumen.imeiCientifico, 1);
  assert.equal(resumen.primero, '13/09/2026 11:36:10');
});

test('the clean sábana has the summary and the removed mirrors; the Ruta file only IMEI and coordinates', () => {
  const { sabana, geo, resumen } = procesarSabana(telcel(), '.xlsx', 'sabana.xlsx');
  const book = sheetsOf(sabana);
  assert.deepEqual(Object.keys(book), ['Sábana', 'Resumen', 'Espejos quitados']);
  assert.equal(book['Sábana'][0][0], 'Linea: 6620000001 con periodo de busqueda del 13/09/2026 al 18/09/2026');
  assert.deepEqual(book['Sábana'][2], HEADER);
  assert.equal(book['Sábana'].length, 3 + 9);
  assert.ok(!book['Sábana'].slice(3).some((row) => row[1] === 'VOZ TRANSITO' && row[3] !== '6620000008'));
  assert.equal(book['Sábana'][3][7], '35290011223344', 'IMEI written as text, not 3.5029E+13');
  const resumenSheet = Object.fromEntries(book.Resumen.filter((row) => row.length >= 2).map((row) => [row[0], row[1]]));
  assert.equal(resumenSheet['Llamadas completadas'], 6);
  assert.equal(resumenSheet['Llamadas no completadas'], 1);
  assert.equal(resumenSheet.Mensajes, 1);
  assert.equal(resumenSheet['IMEI válidos'], 1);
  assert.equal(book['Espejos quitados'].length, 6);

  // Records with IMEI and position: the salientes of 13/09, 14/09, 17/09 (two), the entrante and the message.
  assert.equal(resumen.registrosGeo, 6);
  const rutaRows = readRutaXlsxRows(geo);
  assert.deepEqual(rutaRows[0], HEADER);
  assert.equal(rutaRows.length, 7);
  assert.ok(rutaRows.slice(1).every((row) => row[7] === '35290011223344' && row[8] && row[9]));
});

test('a file without the A, B and date columns is refused with a reason', () => {
  assert.throws(() => limpiarSabana([[['Nombre', 'Dirección'], ['x', 'y']]]), /Número A, Número B y Fecha/);
});

test("Telcel's CSV: dates 2026/09/14 and both coordinates in one quoted LATITUD field", () => {
  const csv = [
    HEADER.join(','),
    `${T},VOZ TRANSITO,${T},6620000002,2026/09/14,07:03:57,59,,,,`,
    `${T},VOZ SALIENTE,${T},6620000002,2026/09/14,08:03:57,57,35290011223344,"29°05'00.00N,110°58'00.00W",150,`,
  ].join('\n');
  const result = limpiarSabana(readSabanaSheets(Buffer.from(csv), '.csv'));
  assert.equal(result.espejos.length, 1);
  assert.deepEqual(result.reales[0].cells.slice(4), ['14/09/2026', '08:03:57', '57', '35290011223344', "29°05'00.00N", "110°58'00.00W", '150']);
  assert.equal(result.geo.length, 1);
});

test('CSV sábanas work too', () => {
  const csv = [HEADER, ...DATA.slice(2, 4)].map((row) => row.join(',')).join('\n');
  const result = limpiarSabana(readSabanaSheets(Buffer.from(csv), '.csv'));
  assert.equal(result.espejos.length, 1);
  assert.equal(result.reales.length, 1);
});
