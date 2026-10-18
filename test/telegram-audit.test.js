import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTelegramApiRouter } from '../src/telegramApiRouter.js';
import { auditActivity } from '../src/auditMiddleware.js';
import { presentAuditEntry } from '../src/auditPresentation.js';

test('Telegram audit identifies authorized users and records queries, maps, geocoding and failures once', async (t) => {
  const events = [];
  const token = 'a'.repeat(64);
  const app = express();
  app.locals.writeAuditLog = (event) => events.push(event);
  app.use(auditActivity);
  const pool = { query: async (sql, params) => {
    if (params[0] === 'fallo') throw new Error('Database unavailable');
    return [[]];
  } };
  app.use('/api/bot', createTelegramApiRouter(pool,
    { TELEGRAM_API_TOKEN: token, TELEGRAM_ALLOWED_USER_IDS: '1234567890123' },
    async () => Buffer.from('png'), async () => ({ ubicacion: 'Centro' })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/bot`;
  const headers = { Authorization: `Bearer ${token}`, 'X-Telegram-User-Id': '1234567890123' };
  await fetch(base + '/linea?q=6621234567');
  await fetch(base + '/linea?q=6621234567', { headers: { ...headers, 'X-Telegram-User-Id': '456' } });
  assert.equal(events.length, 0);
  for (const [path, status] of [
    ['/linea?q=6621234567', 200], ['/imei?q=123456789012345', 200],
    ['/antena?q=Centro&page=2', 200], ['/linea?q=invalid', 400], ['/antena?q=fallo', 503],
  ]) {
    const response = await fetch(base + path, { headers });
    await response.text();
    assert.equal(response.status, status);
  }
  assert.equal(events.length, 5);
  assert.equal(events[0].requestPath, '/api/bot/linea');
  assert.equal(events[0].details.parametros.q, '6621234567');
  assert.equal(events[2].details.parametros.page, '2');
  assert.equal(events[3].statusCode, 400);
  assert.equal(events[4].statusCode, 503);
  const fields = { lat: '29', lng: '-110', azimuth: '50', radius: '500' };
  await (await fetch(base + '/cobertura?' + new URLSearchParams(fields), { headers })).text();
  await (await fetch(base + '/cobertura/ubicacion', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) })).text();
  assert.equal(events.length, 7);
  assert.equal(events[5].details.comando, 'cobertura');
  assert.equal(events[5].statusCode, 200);
  assert.equal(events[6].statusCode, 200);
  assert.equal(events[6].details.datos.lat, '29');
  for (const event of events) {
    assert.equal(event.userId, null);
    assert.equal(event.userEmail, 'Telegram ID 1234567890123');
    assert.equal(event.action, 'SEARCH');
    assert.equal(event.details.origen, 'Telegram');
    assert.equal(event.details.telegram_user_id, '1234567890123');
    assert.ok(!JSON.stringify(event).includes(token));
  }
  const view = presentAuditEntry({ ...events[0], createdAt: '2026-10-17 14:35:22' });
  assert.equal(view.origin, 'Telegram · /linea');
  assert.equal(view.searched, 'q: 6621234567');
  assert.equal(view.day, '2026-10-17');
  assert.equal(view.time, '14:35:22');
});
