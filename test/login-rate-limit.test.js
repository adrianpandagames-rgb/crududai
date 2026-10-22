import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginRateLimiter } from '../src/loginRateLimit.js';

test('blocks an email after too many failures and unblocks when the window ends', () => {
  const limiter = createLoginRateLimiter({ windowMs: 1000, maxPerIp: 100, maxPerEmail: 3 });
  const now = 10_000;

  for (let i = 0; i < 3; i++) limiter.recordFailure('1.1.1.1', 'a@b.com', now);

  assert.equal(limiter.retryAfterMs('2.2.2.2', 'a@b.com', now + 100), 900);
  assert.equal(limiter.retryAfterMs('2.2.2.2', 'otro@b.com', now + 100), 0);
  assert.equal(limiter.retryAfterMs('2.2.2.2', 'a@b.com', now + 1000), 0);
});

test('blocks an IP that tries many different emails', () => {
  const limiter = createLoginRateLimiter({ windowMs: 1000, maxPerIp: 3, maxPerEmail: 100 });
  const now = 10_000;

  limiter.recordFailure('1.1.1.1', 'a@b.com', now);
  limiter.recordFailure('1.1.1.1', 'c@d.com', now);
  limiter.recordFailure('1.1.1.1', 'e@f.com', now);

  assert.ok(limiter.retryAfterMs('1.1.1.1', 'nuevo@b.com', now) > 0);
  assert.equal(limiter.retryAfterMs('9.9.9.9', 'nuevo@b.com', now), 0);
});

test('a successful login clears the email counter but not the IP counter', () => {
  const limiter = createLoginRateLimiter({ windowMs: 1000, maxPerIp: 2, maxPerEmail: 2 });
  const now = 10_000;

  limiter.recordFailure('1.1.1.1', 'a@b.com', now);
  limiter.recordFailure('1.1.1.1', 'a@b.com', now);
  limiter.recordSuccess('a@b.com');

  assert.equal(limiter.retryAfterMs('2.2.2.2', 'a@b.com', now), 0);
  assert.ok(limiter.retryAfterMs('1.1.1.1', 'a@b.com', now) > 0);
});

test('prune removes expired counters', () => {
  const limiter = createLoginRateLimiter({ windowMs: 1000 });
  limiter.recordFailure('1.1.1.1', 'a@b.com', 0);
  assert.equal(limiter.size(), 2);
  limiter.prune(1000);
  assert.equal(limiter.size(), 0);
});
