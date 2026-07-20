import test from 'node:test';
import assert from 'node:assert/strict';

import { maskApiKeyInUrl } from '../src/loggingUtils.js';

test('maskApiKeyInUrl redacts the API key from URLs', () => {
  const url = 'https://dash.imei.info/api/check/0/?API_KEY=super-secret-key&imei=123456789012345';

  assert.equal(
    maskApiKeyInUrl(url),
    'https://dash.imei.info/api/check/0/?API_KEY=[REDACTED]&imei=123456789012345'
  );
});
