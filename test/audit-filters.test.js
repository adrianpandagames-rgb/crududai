import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { auditDayStart, buildAuditFilters, formatAuditTimestamp, auditFilterQuery, auditActionLabels, auditResults, auditOrigins } from '../src/auditFilters.js';
import { auditResources, describeAuditAction } from '../src/auditActions.js';
import { auditRequestAction } from '../src/auditMiddleware.js';
import { auditResultOf, consultarAuditoria, exportarAuditoriaCsv } from '../src/auditService.js';

test('timestamps and day filters use Sonora time, not the UTC server clock', () => {
  // 2026-10-24 01:00 UTC is 2026-10-23 18:00 in Hermosillo.
  assert.equal(formatAuditTimestamp(Date.UTC(2026, 9, 24, 1, 0, 5) / 1000), '2026-10-23 18:00:05');
  assert.equal(auditDayStart('2026-10-23'), Date.UTC(2026, 9, 23, 7) / 1000);
  assert.equal(formatAuditTimestamp(null), '');

  const { where, values } = buildAuditFilters({ desde: '2026-10-23', hasta: '2026-10-23' });
  assert.match(where, /created_at >= FROM_UNIXTIME\(\?\) AND created_at < FROM_UNIXTIME\(\?\)/);
  assert.deepEqual(values.slice(0, 2), [Date.UTC(2026, 9, 23, 7) / 1000, Date.UTC(2026, 9, 24, 7) / 1000]);
});

test('new filters validate their values and escape the free-text search', () => {
  assert.throws(() => buildAuditFilters({ resultado: 'X' }), /resultado válido/);
  assert.throws(() => buildAuditFilters({ origen: 'X' }), /origen válido/);
  assert.throws(() => buildAuditFilters({ texto: 'x'.repeat(101) }), /demasiado largo/);

  const { where, values, filters } = buildAuditFilters({ resultado: 'ERROR', origen: 'TELEGRAM', ip: '10.0.0.1', texto: '50%_off' });
  assert.match(where, /status_code >= 500/);
  assert.match(where, /"origen":"Telegram"/);
  assert.match(where, /ip_address = \?/);
  assert.ok(values.includes('%50\\%\\_off%'));
  assert.ok(values.includes('10.0.0.1'));
  assert.equal(filters.automaticas, '');
});

test('automatic requests are hidden by default and no longer written', () => {
  assert.match(buildAuditFilters().where, /NOT IN/);
  assert.doesNotMatch(buildAuditFilters({ automaticas: '1' }).where, /NOT IN/);
  for (const path of ['/', '/api/localidades', '/api/ubicaciones/heatmap']) {
    assert.equal(auditRequestAction({ method: 'GET', path, query: { estado: 'Sonora' } }), null);
  }
  assert.equal(auditRequestAction({ method: 'GET', path: '/ubicaciones', query: {} }), 'CONSULTA');
});

test('filter links keep only the filters in use', () => {
  const { filters } = buildAuditFilters({ usuario: 'a@b.mx' });
  assert.equal(auditFilterQuery(filters, { page: 2 }), 'usuario=a%40b.mx&page=2');
});

test('common changes get specific action names', () => {
  assert.equal(describeAuditAction({ operation: 'REGISTRO', request_path: '/ruta/importar' }), 'Importó ruta');
  assert.equal(describeAuditAction({ operation: 'REGISTRO', request_path: '/Crud/import-csv' }), 'Importó CSV');
  assert.equal(describeAuditAction({ operation: 'EDITADO', request_path: '/usuarios/7/rol' }), 'Cambió rol de usuario');
  assert.equal(describeAuditAction({ operation: 'EDITADO', request_path: '/ubicaciones/218/modificar' }), 'Editó registro');
  assert.equal(describeAuditAction({ operation: 'SEARCH', request_path: '/imei/register' }), 'Búsqueda');
  assert.equal(describeAuditAction({ operation: 'REGISTRO', request_path: '/nuevo' }), 'Creado');
});

test('status codes map to results', () => {
  assert.equal(auditResultOf(304), 'OK');
  assert.equal(auditResultOf(401), 'DENEGADO');
  assert.equal(auditResultOf(404), 'RECHAZADO');
  assert.equal(auditResultOf(500), 'ERROR');
});

const row = {
  user_email: 'a@b.mx', method: 'SEARCH', request_path: '/Crud', status_code: 304, ip_address: '10.0.0.1',
  details: JSON.stringify({ parametros: { search: '=HYPERLINK("x")' } }), operation: 'SEARCH', resource: 'DATOS',
  createdTs: Date.UTC(2026, 9, 24, 1) / 1000,
};
const fakePool = {
  query: async (sql) => {
    if (sql.includes('COUNT(DISTINCT user_email) AS usuarios')) return [[{ total: 120, usuarios: 3, errores: '2', denegados: 1, fallidos: 4 }]];
    if (sql.includes("method = 'LOGIN_FAILED'")) return [[{ ip: '9.9.9.9', intentos: 4, cuentas: 2, ultimoTs: row.createdTs }]];
    if (sql.includes('DISTINCT user_email FROM')) return [[{ user_email: 'a@b.mx' }]];
    return [[row]];
  },
};

test('the page renders summary, failed logins, results and pagination', async () => {
  const selection = buildAuditFilters({ usuario: 'a@b.mx' });
  const data = await consultarAuditoria(fakePool, selection, 1);
  assert.equal(data.totalPages, 3);
  assert.equal(data.entries[0].resultLabel, 'Correcto (caché)');
  assert.equal(data.entries[0].day, '2026-10-23');
  const html = await ejs.renderFile('views/pages/auditoria.ejs', {
    ...data, filters: selection.filters, filterError: null, auditActionLabels, auditResources, auditResults, auditOrigins,
    auditFilterQuery, exportLimit: 10000, currentUser: { isAdmin: true, role: 'admin' },
  });
  assert.match(html, /Intentos de sesión fallidos por IP/);
  assert.match(html, /9\.9\.9\.9/);
  assert.match(html, /href="\/auditoria\/exportar\?usuario=a%40b.mx"/);
  assert.match(html, /Página 1 de 3/);
  assert.match(html, /page=2/);
});

test('the CSV export neutralises spreadsheet formulas', async () => {
  const pool = { query: async () => [[{ ...row, user_email: '=HYPERLINK("x")' }]] };
  const { csv } = await exportarAuditoriaCsv(pool, buildAuditFilters());
  assert.ok(csv.startsWith('﻿"Fecha"'));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"2026-10-23 18:00:00"/);
});

test('mounted routers are audited with their full path', async (t) => {
  const { default: express } = await import('express');
  const { auditActivity } = await import('../src/auditMiddleware.js');
  const app = express();
  const events = [];
  app.locals.writeAuditLog = (entry) => events.push(entry);
  app.use(auditActivity);
  app.use((req, res, next) => { req.session = { userId: 1, email: 'a@b.mx' }; next(); });
  const router = express.Router();
  router.get('/', (req, res) => res.send('ok'));
  router.post('/importar', (req, res) => res.json({ ok: true }));
  app.use('/planeacion-geografica', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/planeacion-geografica`);
  await fetch(`${base}/planeacion-geografica/importar`, { method: 'POST' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.map(({ requestPath, action }) => `${action} ${requestPath}`),
    ['CONSULTA /planeacion-geografica', 'POST /planeacion-geografica/importar']);
});

test('the header lights up the section being viewed, sub-pages included', async () => {
  const render = (currentPath) => ejs.renderFile('views/includes/header.ejs', { currentUser: { isAdmin: true, role: 'admin' }, currentPath });
  const current = (html) => [...html.matchAll(/class="menu-item is-current"[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(current(await render('/imei/editar/5')), ['Datos conservados', 'IMEI']);
  assert.deepEqual(current(await render('/planeacion-geografica')), ['Mapeo', 'Planeación geográfica']);
  assert.deepEqual(current(await render('/auditoria')), ['Administración', 'Auditoría']);
  assert.deepEqual(current(await render('/metricas')), ['Métricas']);
  assert.deepEqual(current(await render('/imeis')), []);
  assert.match(await render('/ruta'), /href="\/ruta" aria-current="page"/);
  assert.deepEqual(current(await ejs.renderFile('views/includes/header.ejs', { currentUser: { isAdmin: false } })), []);
});

test('the menu is grouped and each role keeps exactly its links', async () => {
  const menu = async (currentUser) => {
    const html = await ejs.renderFile('views/includes/header.ejs', { currentUser, currentPath: '/' });
    return [...html.matchAll(/<summary[^>]*>([^<]+)<\/summary>|<a class="menu-item[^"]*" href="[^"]+"[^>]*>([^<]+)</g)]
      .map(([, group, link]) => (group ? `[${group}]` : link));
  };
  assert.deepEqual(await menu({ isAdmin: true, role: 'admin' }), [
    'Métricas',
    '[Datos conservados]', 'Líneas', 'IMEI',
    '[Mapeo]', 'Ubicaciones', 'Georeferenciación', 'Planeación geográfica', 'Ruta',
    '[OSINT]', 'Líneas Internacionales', 'Maigret', 'RastroX', 'Búsqueda por imagen',
    '[Administración]', 'Usuarios', 'Auditoría', 'Medidores', 'Red telefónica',
    'Cerrar sesión',
  ]);
  const user = await menu({ isAdmin: false, role: 'usuario' });
  assert.ok(user.includes('Métricas') && !user.includes('Georeferenciación') && !user.includes('[Administración]'));
  const uecs = await menu({ isAdmin: false, role: 'uecs' });
  assert.ok(!uecs.includes('Métricas') && uecs.includes('Georeferenciación') && !uecs.includes('[Administración]'));
});
