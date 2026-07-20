import assert from 'assert';
import { fetchImeiMetadata } from '../src/router.js';
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
  it('checks the account endpoint first and retries once on timeout', async () => {
    const originalRequest = https.request;
    let attempts = 0;

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

    const result = await fetchImeiMetadata('123456789012345');
    assert.strictEqual(attempts, 3, 'Should preflight account endpoint and then retry metadata once');
    assert.deepStrictEqual(result, { brand_name: null, modelo: null, raw: null });

    https.request = originalRequest;
  });
});
