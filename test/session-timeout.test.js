import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionCookieOptions, isSessionExpired } from '../src/sessionUtils.js';

test('buildSessionCookieOptions sets a 10-minute maxAge for active sessions', () => {
  const options = buildSessionCookieOptions(false);

  assert.equal(options.maxAge, 10 * 60 * 1000);
  assert.equal(options.path, '/');
  assert.equal(options.sameSite, 'lax');
});

test('isSessionExpired marks sessions older than 10 minutes as expired', () => {
  const now = Date.now();

  assert.equal(isSessionExpired({ lastActivity: now - (11 * 60 * 1000) }, now), true);
  assert.equal(isSessionExpired({ lastActivity: now - (5 * 60 * 1000) }, now), false);
});
