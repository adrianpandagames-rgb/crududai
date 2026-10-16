import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireSameOrigin } from '../src/requestSecurity.js';

function check(headers, protocol = 'https') {
  let status = null;
  let allowed = false;
  const req = { protocol, get: name => headers[name.toLowerCase()] };
  const res = { status(value) { status = value; return this; }, send() {} };
  requireSameOrigin(req, res, () => { allowed = true; });
  return { status, allowed };
}

test('login accepts its own HTTPS origin including the actual port', () => {
  assert.deepEqual(check({ host: 'localhost:3443', origin: 'https://localhost:3443' }), { status: null, allowed: true });
  assert.deepEqual(check({ host: 'localhost:3443', referer: 'https://localhost:3443/' }), { status: null, allowed: true });
});

test('login rejects foreign, opaque, missing, insecure and wrong-port origins', () => {
  for (const origin of ['https://attacker.invalid', 'null', undefined, 'http://localhost:3443', 'https://localhost:3444']) {
    assert.deepEqual(check({ host: 'localhost:3443', origin }), { status: 403, allowed: false });
  }
});

test('a same-origin Referer does not override a foreign Origin', () => {
  assert.deepEqual(check({ host: 'localhost:3443', origin: 'https://attacker.invalid', referer: 'https://localhost:3443/' }), { status: 403, allowed: false });
});

test('same-origin browser metadata permits forms with hidden origins', () => {
  for (const origin of ['null', undefined]) {
    assert.deepEqual(check({ host: 'localhost:3443', origin, 'sec-fetch-site': 'same-origin' }), { status: null, allowed: true });
    for (const site of ['cross-site', 'same-site', 'none', undefined]) {
      assert.deepEqual(check({ host: 'localhost:3443', origin, 'sec-fetch-site': site }), { status: 403, allowed: false });
    }
  }
});

test('metadata cannot override an explicit foreign or malformed origin', () => {
  for (const origin of ['https://attacker.invalid', 'invalid']) {
    assert.deepEqual(check({ host: 'localhost:3443', origin, 'sec-fetch-site': 'same-origin' }), { status: 403, allowed: false });
  }
});

test('origin comparison uses the connection protocol and exposed port', () => {
  assert.deepEqual(check({ host: 'localhost:3444', origin: 'https://localhost:3444' }), { status: null, allowed: true });
  assert.deepEqual(check({ host: '[::1]:3443', origin: 'https://[::1]:3443' }), { status: null, allowed: true });
  assert.deepEqual(check({ host: 'localhost:3600', origin: 'http://localhost:3600' }, 'http'), { status: null, allowed: true });
});

test('downstream route errors are not swallowed by the origin guard', () => {
  const failure = new Error('route failure');
  const req = { protocol: 'https', get: name => ({ host: 'localhost:3443', origin: 'https://localhost:3443' })[name.toLowerCase()] };
  const res = { status() { assert.fail('must not replace the route error with HTTP 403'); } };
  assert.throws(() => requireSameOrigin(req, res, () => { throw failure; }), error => error === failure);
});

test('Express delivers same-origin POSTs and preserves downstream error responses', async t => {
  const app = express();
  app.post('/login', requireSameOrigin, (_req, res) => res.sendStatus(204));
  app.post('/route-error', requireSameOrigin, () => { throw new Error('route failure'); });
  app.use((error, _req, res, _next) => res.status(500).send(error.message));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [{ Origin: base }, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }]) {
    const response = await fetch(`${base}/login`, { method: 'POST', headers });
    assert.equal(response.status, 204);
  }
  const rejected = await fetch(`${base}/login`, { method: 'POST', headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(rejected.status, 403);
  const failed = await fetch(`${base}/route-error`, { method: 'POST', headers: { Origin: base } });
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), 'route failure');
});
