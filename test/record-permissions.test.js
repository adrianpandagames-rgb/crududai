import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRecordCreator } from '../src/recordPermissions.js';

test('UECS cannot create records even by a direct request', () => {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  requireRecordCreator({ session: { userId: 1, role: 'uecs' } }, res, () => assert.fail('must deny creation'));
  assert.equal(res.code, 403);
  assert.ok(res.body.error);
});

test('existing creation permissions remain available for other authenticated roles', () => {
  for (const role of ['admin', 'semiadmin', 'usuario']) {
    let allowed = false;
    requireRecordCreator({ session: { userId: 1, role } }, {}, () => { allowed = true; });
    assert.equal(allowed, true);
  }
});

test('record creation requires an authenticated session', () => {
  const res = { status(code) { this.code = code; return this; }, json() {} };
  requireRecordCreator({}, res, () => assert.fail('must require authentication'));
  assert.equal(res.code, 401);
});
