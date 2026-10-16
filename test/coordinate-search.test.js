import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchCoordinates } from '../src/coordinateSearch.js';
import { buildTelegramQuery } from '../src/telegramApiRouter.js';

test('DMS searches bind the same decimal values as existing decimal searches', () => {
  for (const term of ['29°4\u002719.2\u0022N, 110°57\u002721.6\u0022W', '29° 4′ 19.2″ N 110° 57′ 21.6″ O', '29º4\u002719.2n;110º57\u002721.6w']) {
    const { latitude, longitude } = parseSearchCoordinates(term);
    assert.ok(Math.abs(latitude - 29.072) < 1e-10);
    assert.ok(Math.abs(longitude + 110.956) < 1e-10);
    const query = buildTelegramQuery('antena', term, 2);
    assert.ok(query.sql.includes('ABS(CAST(latitude'));
    assert.ok(Math.abs(query.params[0] - 29.072) < 1e-10);
    assert.ok(Math.abs(query.params[1] + 110.956) < 1e-10);
    assert.deepEqual(query.params.slice(2), [6, 5]);
  }
});

test('decimal, mixed coordinates, boundaries and south/east remain supported', () => {
  assert.deepEqual(parseSearchCoordinates('29.072,-110.956'), { latitude: 29.072, longitude: -110.956 });
  assert.deepEqual(buildTelegramQuery('antena', '29.072 -110.956', 1).params, [29.072, -110.956, 6, 0]);
  assert.deepEqual(parseSearchCoordinates('29 -110'), { latitude: 29, longitude: -110 });
  assert.throws(() => parseSearchCoordinates('123 456'));
  assert.deepEqual(parseSearchCoordinates('29°0\u00270\u0022S, 110°0\u00270\u0022E'), { latitude: -29, longitude: 110 });
  assert.deepEqual(parseSearchCoordinates('90°0\u00270\u0022N, 180°0\u00270\u0022E'), { latitude: 90, longitude: 180 });
  assert.deepEqual(parseSearchCoordinates('29°0\u00270\u0022N, -110'), { latitude: 29, longitude: -110 });
  assert.equal(parseSearchCoordinates('Hermosillo'), null);
});

test('invalid DMS never falls back to a text search', () => {
  for (const term of ['29°60\u00270\u0022N,110°0\u00270\u0022W', '29°0\u002760\u0022N,110°0\u00270\u0022W', '90°0\u00271\u0022N,110°0\u00270\u0022W', '29°0\u00270\u0022W,110°0\u00270\u0022N', '29°4\u002719\u0022N', '-29°0\u00270\u0022N,110°0\u00270\u0022W']) {
    assert.throws(() => buildTelegramQuery('antena', term, 1));
  }
});
