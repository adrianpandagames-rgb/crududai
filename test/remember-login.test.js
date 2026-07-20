import test from 'node:test';
import assert from 'node:assert/strict';
import { getRememberedCredentials, buildCookieOptions } from '../src/authCookies.js';

test('getRememberedCredentials parses remembered email, password and checkbox state', () => {
  const req = {
    headers: {
      cookie: 'rememberedEmail=demo%40mail.com; rememberedPassword=secret123; rememberedCredentials=true'
    }
  };

  assert.deepEqual(getRememberedCredentials(req), {
    email: 'demo@mail.com',
    password: 'secret123',
    rememberMe: true
  });
});

test('buildCookieOptions sets a long-lived expiry for remembered credentials', () => {
  const options = buildCookieOptions(true);

  assert.equal(options.maxAge, 30 * 24 * 60 * 60 * 1000);
  assert.equal(options.path, '/');
  assert.equal(options.sameSite, 'lax');
});
