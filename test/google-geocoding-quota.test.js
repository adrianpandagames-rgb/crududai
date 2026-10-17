import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGoogleGeocodingQuota,
  resetGoogleGeocodingQuota,
  reserveGoogleGeocodingRequest,
} from '../src/googleGeocodingQuota.js';

function createQuotaPool() {
  const state = { requestCount: 0, isBlocked: 0 };
  return {
    state,
    query: async () => [[]],
    execute: async (sql, parameters = []) => {
      if (sql.startsWith('INSERT IGNORE')) return [{ affectedRows: 1 }];
      if (sql.startsWith('SELECT request_count')) {
        return [[{ requestCount: state.requestCount, isBlocked: state.isBlocked }]];
      }
      if (sql.includes('SET request_count = 0')) {
        state.requestCount = 0;
        state.isBlocked = 0;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE google_geocoding_quota')) {
        if (state.isBlocked || state.requestCount >= parameters[2]) return [{ affectedRows: 0 }];
        state.isBlocked = Number(state.requestCount >= parameters[0]);
        state.requestCount += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected quota SQL: ${sql}`);
    },
  };
}

test('Google Geocoding quota blocks exactly at 8000 requests and admin reset unlocks it', async () => {
  const pool = createQuotaPool();
  const originalError = console.error;
  const alarms = [];
  console.error = (...args) => alarms.push(args);
  try {
    for (let request = 0; request < 8000; request += 1) {
      await reserveGoogleGeocodingRequest(pool);
    }
  } finally {
    console.error = originalError;
  }

  assert.equal(pool.state.requestCount, 8000);
  assert.equal(pool.state.isBlocked, 1);
  assert.equal(alarms.length, 1);
  assert.match(alarms[0][0], /ALARMA/);
  await assert.rejects(reserveGoogleGeocodingRequest(pool), { code: 'GOOGLE_GEOCODING_QUOTA_BLOCKED' });
  assert.deepEqual(await getGoogleGeocodingQuota(pool), { requestCount: 8000, isBlocked: true, limit: 8000 });
  assert.deepEqual(await resetGoogleGeocodingQuota(pool), { requestCount: 0, isBlocked: false, limit: 8000 });
  await reserveGoogleGeocodingRequest(pool);
  assert.equal(pool.state.requestCount, 1);
});
