import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTelegramApiRouter, buildTelegramQuery } from '../src/telegramApiRouter.js';
import { telegramTestConfig, withLinkedTelegramUsers } from './support/telegram-auth.js';

test('bot API requires its own token and an authorized Telegram user before querying', async t => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return [Array.from({ length: 6 }, (_, id) => ({ id }))]; } };
  const token = 'a'.repeat(64);
  const app = express();
  const config = telegramTestConfig(token);
  app.use('/api/bot', createTelegramApiRouter(withLinkedTelegramUsers(pool, config, ['123']), config));
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
  assert.ok(line.sql.includes('o.delito'));
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
  const config = telegramTestConfig(token);
  const pool = withLinkedTelegramUsers({ query: async () => { throw { code: 'TEST_FAILURE' }; } }, config, ['123']);
  app.use('/api/bot', createTelegramApiRouter(pool, config));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bot/linea?q=6621234567`, { headers: { Authorization: `Bearer ${token}`, 'X-Telegram-User-Id': '123' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'No fue posible consultar los registros.' });
});

test('a missing Telegram ID encryption key reports the API as unconfigured', async t => {
  const app = express();
  const token = 'a'.repeat(64);
  app.use('/api/bot', createTelegramApiRouter({ execute: async () => { throw new Error('Unexpected DB query'); } }, { TELEGRAM_API_TOKEN: token }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bot/linea?q=6621234567`, { headers: { Authorization: `Bearer ${token}`, 'X-Telegram-User-Id': '123' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'API del bot no configurada.' });
});

test('bot Maigret searches run as the linked user and only expose quick or normal depth', async t => {
  const { MaigretQueueFullError } = await import('../src/maigretRouter.js');
  const token = 'a'.repeat(64);
  const config = { ...telegramTestConfig(token), PUBLIC_BASE_URL: 'https://app.example/' };
  const { telegramIdHash } = await import('../src/telegramIdCrypto.js');
  const linked = telegramIdHash('123', config);
  const pool = { execute: async (_sql, [hash]) => [hash === linked ? [{ id: 7, role: 'uecs', is_admin: 0 }] : []] };
  const enqueued = [];
  const lookups = [];
  let queueFull = false;
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const searches = {
    initialize: async () => {},
    enqueue: async (user, search) => {
      if (queueFull) throw new MaigretQueueFullError();
      enqueued.push({ user, search });
      return id;
    },
    find: async (user, searchId, columns) => {
      lookups.push({ user, searchId });
      if (searchId !== id) return null;
      return columns.includes('report_html IS NOT NULL')
        ? { id, username: 'guero_hmo', mode: 'rapida', status: 'listo', total: 1, error: null, hasReport: 1,
          results: JSON.stringify({ accounts: [{ username: 'guero_hmo', site: 'GitHub', url: 'https://github.com/guero_hmo', similar: false, tags: ['coding'], fields: [{ key: 'bio', value: 'x' }] }] }) }
        : { report_html: '<p>reporte</p>' };
    },
  };
  const app = express();
  app.use('/api/bot', createTelegramApiRouter(pool, config, undefined, async () => ({}), searches));
  app.use('/sin-maigret', createTelegramApiRouter(pool, config, undefined, async () => ({})));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'X-Telegram-User-Id': '123', 'Content-Type': 'application/json' };
  const start = (body, path = '/api/bot') => fetch(`${root}${path}/maigret`, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await start({ usuario: '--all-sites' })).status, 400);
  const accepted = await start({ usuario: '@guero_hmo', modo: 'completa' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { id, username: 'guero_hmo', mode: 'rapida' });
  assert.equal((await start({ usuario: 'guero_hmo', modo: 'normal' })).status, 202);
  assert.deepEqual(enqueued.map(({ search }) => search.mode), ['rapida', 'normal']);
  assert.deepEqual(enqueued[0].user, { userId: 7, isAdmin: false, role: 'uecs' });
  assert.equal(enqueued[0].search.recursive, true);
  queueFull = true;
  assert.equal((await start({ usuario: 'guero_hmo' })).status, 429);
  assert.equal((await start({ usuario: 'guero_hmo' }, '/sin-maigret')).status, 503);

  const status = await (await fetch(`${root}/api/bot/maigret/${id}`, { headers })).json();
  assert.deepEqual(status, {
    id, username: 'guero_hmo', mode: 'rapida', status: 'listo', total: 1, error: null, has_report: true,
    web_url: `https://app.example/maigret/${id}`,
    accounts: [{ username: 'guero_hmo', site: 'GitHub', url: 'https://github.com/guero_hmo', similar: false }],
  });
  assert.equal(lookups[0].user.role, 'uecs');
  assert.equal((await fetch(`${root}/api/bot/maigret/otro-id`, { headers })).status, 404);
  const report = await fetch(`${root}/api/bot/maigret/${id}/reporte`, { headers });
  assert.equal(report.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await report.text(), '<p>reporte</p>');
});
