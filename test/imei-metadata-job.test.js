import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRetryImeiMetadata, getNextNoonRunDelay } from '../src/imeiMetadataService.js';

test('shouldRetryImeiMetadata detects records missing brand or model', () => {
  assert.equal(shouldRetryImeiMetadata({ brand_name: null, modelo: 'iPhone' }), true);
  assert.equal(shouldRetryImeiMetadata({ brand_name: 'Apple', modelo: null }), true);
  assert.equal(shouldRetryImeiMetadata({ brand_name: 'Apple', modelo: 'iPhone' }), false);
});

test('shouldRetryImeiMetadata stops after two daily not-found checks', () => {
  assert.equal(shouldRetryImeiMetadata({ brand_name: null, modelo: null, metadata_check_count: 1 }), true);
  assert.equal(shouldRetryImeiMetadata({ brand_name: null, modelo: null, metadata_check_count: 2 }), false);
  assert.equal(shouldRetryImeiMetadata({ brand_name: null, modelo: null, metadata_not_found: 1 }), false);
});

test('getNextNoonRunDelay schedules the next run for the next day when the current time is after noon', () => {
  const now = new Date('2026-07-17T13:30:00');
  const delay = getNextNoonRunDelay(now);

  assert.ok(delay > 0);
  assert.ok(delay >= 23 * 60 * 60 * 1000);
});
