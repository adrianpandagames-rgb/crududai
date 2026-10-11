import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTelegramApiRouter, buildTelegramQuery } from '../src/telegramApiRouter.js';

test('bot API requires its own token and an authorized Telegram user before querying', async t => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return [Array.from({ length: 6 }, (_, id) => ({ id }))]; } };
  const token = 'a'.repeat(64);
  const app = express();
  app.use('/api/bot', createTelegramApiRouter(pool, { TELEGRAM_API_TOKEN: token, TELEGRAM_ALLOWED_USER_IDS: '123' }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/bot`;
  const headers = { Authorization: `Bearer ${token}`, 'X-Telegram-User-Id': '123' };
  assert.equal((await fetch(`${base}/linea?q=6621234567`)).status, 401);
  assert.equal((await fetch(`${base}/linea?q=6621234567`, { headers: { ...headers, 'X-Telegram-User-Id': '456' } })).status, 403);
  assert.equal(calls.length, 0);
  for (const [command, q] of [['linea', '6621234567'], ['imei', '123456789012345'], ['antena', 'Hermosillo'], ['antena', '29°4\u002719.2\u0022N, 110°57\u002721.6\u0022W']]) {
    const response = await fetch(`${base}/${command}?q=${encodeURIComponent(q)}&page=2`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.rows.length, command === 'linea' ? 6 : 5);
    assert.equal(data.has_more, command !== 'linea');
    assert.equal(data.page, command === 'linea' ? 1 : 2);
  }
  assert.equal((await fetch(`${base}/linea?q=invalid`, { headers })).status, 400);
  assert.equal(calls.length, 4);
  assert.ok(Math.abs(calls[3].params[0] - 29.072) < 1e-10);
  assert.ok(Math.abs(calls[3].params[1] + 110.956) < 1e-10);
  assert.equal((await fetch(`${base}/linea?q=6621234567`, { method: 'POST', headers })).status, 404);
});

test('queries validate input and bind values rather than interpolating SQL', () => {
  const line = buildTelegramQuery('linea', '6621234567', 2);
  assert.deepEqual(line.params, Array(5).fill('6621234567'));
  assert.ok(line.sql.includes('AS numeroConsultado'));
  assert.ok(line.sql.includes('AS esObjetivo'));
  assert.ok(line.sql.includes('AS esContacto'));
  assert.ok(!line.sql.includes('LIMIT'));
  assert.deepEqual(buildTelegramQuery('antena', '29,-110', 1).params, [29, -110, 6, 0]);
  const query = buildTelegramQuery('antena', "' OR 1=1 --", 1);
  assert.ok(!query.sql.includes("' OR 1=1 --"));
  for (const args of [['antena', '91,0', 1], ['linea', '', 1], ['imei', 'invalid', 1], ['linea', '6621234567', 101]]) assert.throws(() => buildTelegramQuery(...args));
});

test('database failures produce a generic 503 and no credentials', async t => {
  const app = express();
  const token = 'a'.repeat(64);
  app.use('/api/bot', createTelegramApiRouter({ query: async () => { throw { code: 'TEST_FAILURE' }; } }, { TELEGRAM_API_TOKEN: token, TELEGRAM_ALLOWED_USER_IDS: '123' }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bot/linea?q=6621234567`, { headers: { Authorization: `Bearer ${token}`, 'X-Telegram-User-Id': '123' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'No fue posible consultar los registros.' });
});
