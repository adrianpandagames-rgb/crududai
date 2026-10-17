import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { auditActivity, auditRequestAction } from '../src/auditMiddleware.js';

test('all page filters and search endpoints are audited without a page allowlist', () => {
  for (const path of ['/Crud', '/imei', '/ubicaciones', '/georeferenciacion', '/metricas/resumen', '/auditoria', '/nueva-pagina']) {
    assert.equal(auditRequestAction({ method: 'GET', path, query: { cualquierFiltro: 'dato' } }), 'SEARCH');
    assert.equal(auditRequestAction({ method: 'GET', path, query: {} }), 'CONSULTA');
  }
  assert.equal(auditRequestAction({ method: 'POST', path: '/api/telefono/validar' }), 'SEARCH');
  assert.equal(auditRequestAction({ method: 'POST', path: '/nueva-pagina/buscar' }), 'SEARCH');
  assert.equal(auditRequestAction({ method: 'GET', path: '/imei', query: { page: '2', partial: 'true' } }), 'CONSULTA');
});

test('middleware records one event including complete filters, failures and authenticated identity', async (t) => {
  const app = express();
  const events = [];
  app.locals.writeAuditLog = (entry) => events.push(entry);
  app.use(express.json());
  app.use(auditActivity);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/anonimo')) req.session = { userId: 42, email: 'usuario@example.com' };
    next();
  });
  app.use((req, res) => res.status(req.path === '/fallo' ? 503 : 200).json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const search = 'dato & consulta = ' + 'x'.repeat(250);
  await fetch(`${base}/georeferenciacion?${new URLSearchParams({ search, lugar: 'Centro', token: 'privado' })}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'SEARCH');
  assert.equal(events[0].userId, 42);
  assert.equal(events[0].requestPath, '/georeferenciacion');
  assert.equal(events[0].details.parametros.search, search);
  assert.equal(events[0].details.parametros.lugar, 'Centro');
  assert.equal(events[0].details.parametros.token, '[OCULTO]');
  await fetch(`${base}/api/telefono/validar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numero: '6621234567', password: 'privado' }) });
  assert.equal(events[1].action, 'SEARCH');
  assert.equal(events[1].details.datos.numero, '6621234567');
  assert.equal(events[1].details.datos.password, '[OCULTO]');
  await fetch(`${base}/fallo?q=consulta`);
  assert.equal(events[2].statusCode, 503);
  assert.equal(events[2].action, 'SEARCH');
  await fetch(`${base}/metricas`);
  assert.equal(events[3].action, 'CONSULTA');
  for (const path of ['/health', '/health/ready', '/api/route-toast', '/public/style.css', '/anonimo?q=uno']) await fetch(base + path);
  assert.equal(events.length, 4);
});
