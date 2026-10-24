import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { agruparCiudades, completarDias, obtenerMedidores } from '../src/medidoresService.js';
import { auditRequestAction } from '../src/auditMiddleware.js';

test('keeps short city lists and sums the tail as "Otras"', () => {
  const rows = [{ ciudad: 'Hermosillo', total: '5' }, { ciudad: 'Nogales', total: 3 }, { ciudad: 'Guaymas', total: 2 }, { ciudad: 'Navojoa', total: 1 }];
  assert.deepEqual(agruparCiudades(rows, 4), rows.map(({ ciudad, total }) => ({ ciudad, total: Number(total) })));
  assert.deepEqual(agruparCiudades(rows, 2), [
    { ciudad: 'Hermosillo', total: 5 },
    { ciudad: 'Nogales', total: 3 },
    { ciudad: 'Otras (2)', total: 3, otras: true },
  ]);
});

test('fills every day of the trend, oldest first, across month boundaries', () => {
  const days = completarDias([{ dia: '2026-10-01', total: '4' }, { dia: '2026-09-29', total: 1 }], '2026-10-01', 4);
  assert.deepEqual(days, [
    { dia: '2026-09-28', total: 0 },
    { dia: '2026-09-29', total: 1 },
    { dia: '2026-09-30', total: 0 },
    { dia: '2026-10-01', total: 4 },
  ]);
});

const fakePool = (counts, cities = [], trend = [], quota = { requestCount: 6400, isBlocked: 0 }) => ({
  execute: async () => [[quota]],
  query: async (sql) => {
    if (sql.includes('AS hoy')) return [[{ ...counts, hoy: '2026-10-24' }]];
    if (sql.includes('GROUP BY COALESCE')) return [cities];
    return [trend];
  },
});

const counts = {
  objetivos: 3, objetivosImei: 2, imeis: 4, contactos: 6, ubicaciones: 9, usuarios: 2,
  imeisConMetadata: 3, imeisPendientes: 1,
  ubicacionesSinCoordenadas: 0, ubicacionesSinCiudad: 2, objetivosImeiSinImei: 1, objetivosSinContactos: 0,
};

test('summarises counts, IMEI completion and recent activity', async () => {
  const data = await obtenerMedidores(fakePool(counts, [{ ciudad: 'Hermosillo', total: 9 }], [
    { dia: '2026-10-24', total: 2 }, { dia: '2026-10-10', total: 5 },
  ]));
  assert.equal(data.metrics.objetivos, 3);
  assert.equal(data.metrics.hoy, undefined);
  assert.equal(data.imeiCompletion, 75);
  assert.equal(data.tendencia.length, 30);
  assert.equal(data.ultimos7, 2);
  assert.equal(data.ultimos30, 7);
  assert.equal(data.totalCiudades, 1);
});

test('renders the summary with links to pending records and data-quality warnings', async () => {
  const data = await obtenerMedidores(fakePool(counts, [{ ciudad: 'San Luis Río Colorado', total: 9 }], [{ dia: '2026-10-24', total: 2 }]));
  const html = await ejs.renderFile('views/partials/medidores-resumen.ejs', data);
  assert.match(html, /href="\/imei\?pendientes=1"/);
  assert.match(html, /75%/);
  assert.match(html, /href="\/ubicaciones\?search=San%20Luis%20R%C3%ADo%20Colorado"/);
  assert.match(html, /<a href="\/ubicaciones">Ubicaciones sin ciudad<\/a>/);
  assert.doesNotMatch(html, /<a href="\/Crud">Objetivos sin contactos<\/a>/);
});

test('renders an empty dashboard without errors', async () => {
  const empty = Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));
  const data = await obtenerMedidores(fakePool(empty));
  const html = await ejs.renderFile('views/partials/medidores-resumen.ejs', data);
  assert.match(html, /Sin ubicaciones nuevas/);
  assert.match(html, /Aún no hay antenas registradas/);
  assert.equal(data.imeiCompletion, 0);
});

test('the auto-refresh endpoint stays out of the audit log', () => {
  assert.equal(auditRequestAction({ method: 'GET', path: '/medidores/resumen', query: {} }), null);
  assert.equal(auditRequestAction({ method: 'GET', path: '/medidores', query: {} }), 'CONSULTA');
});

test('the Google Geocoding quota moved here from the users page', async () => {
  const data = await obtenerMedidores(fakePool(counts));
  const html = await ejs.renderFile('views/partials/medidores-resumen.ejs', data);
  assert.match(html, /6,400 \/ 8,000/);
  assert.match(html, /action="\/medidores\/google-geocoding\/reiniciar"/);
  assert.match(html, /bar-fill is-high/);
  assert.doesNotMatch(html, /ALARMA/);
});
