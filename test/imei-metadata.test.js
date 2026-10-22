import { describe, it } from 'node:test';
import assert from 'assert';
import { fetchImeiMetadata } from '../src/router.js';
import pool from '../src/db.js';
import https from 'https';

// Minimal fake request/response helper for https.request mocking
class FakeReq {
  constructor() {
    this.events = {};
    this.destroyed = false;
  }

  on(event, callback) {
    this.events[event] = callback;
  }

  end() {
    return undefined;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeRes {
  constructor(statusCode = 200, body = '') {
    this.events = {};
    this.statusCode = statusCode;
    this.body = body;
  }

  on(event, callback) {
    this.events[event] = callback;
    return this;
  }

  emit(event, value) {
    if (this.events[event]) {
      this.events[event](value);
    }
  }
}

describe('fetchImeiMetadata', () => {
  it('reuses stored metadata when the IMEI already exists in the database', async () => {
    const originalRequest = https.request;
    const originalQuery = pool.query;
    let apiCalled = false;

    pool.query = async (sql, params) => {
      if (sql.includes('SELECT brand_name, modelo')) {
        return [[{ brand_name: 'Apple', modelo: 'iPhone' }]];
      }

      throw new Error(`Unexpected SQL query: ${sql}`);
    };

    https.request = () => {
      apiCalled = true;
      throw new Error('External IMEI API should not be called when stored metadata exists');
    };

    try {
      const result = await fetchImeiMetadata('123456789012345');
      assert.strictEqual(apiCalled, false, 'The external IMEI API should not be called when stored metadata exists');
      assert.deepStrictEqual(result, {
        brand_name: 'Apple',
        modelo: 'iPhone',
        raw: null,
        available: true,
      });
    } finally {
      pool.query = originalQuery;
      https.request = originalRequest;
    }
  });

  it('checks the account endpoint first and retries once on timeout', async () => {
    const originalRequest = https.request;
    const originalQuery = pool.query;
    const originalApiKey = process.env.IMEI_API_KEY;
    process.env.IMEI_API_KEY = 'test-key';
    let attempts = 0;

    pool.query = async (sql) => {
      if (sql.includes('SELECT brand_name, modelo')) {
        return [[]];
      }

      throw new Error(`Unexpected SQL query: ${sql}`);
    };

    https.request = (options, callback) => {
      attempts += 1;
      const req = new FakeReq();
      const fakeRes = new FakeRes(200, '{}');

      process.nextTick(() => {
        callback(fakeRes);
        if (options.path.includes('/api/account/account/')) {
          fakeRes.emit('data', '{}');
          fakeRes.emit('end');
        } else {
          req.events.timeout?.();
        }
      });

      return req;
    };

    try {
      const result = await fetchImeiMetadata('123456789012345');
      assert.strictEqual(attempts, 3, 'Should preflight account endpoint and then retry metadata once');
      assert.deepStrictEqual(result, { brand_name: null, modelo: null, raw: null });
    } finally {
      pool.query = originalQuery;
      https.request = originalRequest;
      if (originalApiKey === undefined) delete process.env.IMEI_API_KEY;
      else process.env.IMEI_API_KEY = originalApiKey;
    }
  });
});
