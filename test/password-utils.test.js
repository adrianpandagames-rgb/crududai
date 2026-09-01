import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, isBcryptHash, verifyPassword } from '../src/passwordUtils.js';

test('hashPassword generates a bcrypt hash that verifyPassword can validate', async () => {
  const hash = await hashPassword('correct horse battery staple');

  assert.equal(isBcryptHash(hash), true);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('incorrect', hash), false);
});

test('verifyPassword rejects a plaintext stored password', async () => {
  assert.equal(await verifyPassword('secret123', 'secret123'), false);
});
