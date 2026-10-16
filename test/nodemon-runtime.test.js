import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const match = require('nodemon/lib/monitor/match');
const configuration = require('../nodemon.json');

test('runtime map JSON does not restart Node, while application source still does', () => {
  const rules = ['**/*', ...configuration.ignore.map((pattern) => '!' + pattern)];
  const cachedTile = path.resolve('data/map-tiles/15-6281-13606.json');
  assert.equal(match([cachedTile], ['**/*'], 'js,json').result.length, 1);
  assert.equal(match([cachedTile], [...rules], 'js,json').result.length, 0);
  assert.equal(match([path.resolve('src/antenaMapService.js')], [...rules], 'js,json').result.length, 1);
  assert.equal(match([path.resolve('app.js')], [...rules], 'js,json').result.length, 1);
});
