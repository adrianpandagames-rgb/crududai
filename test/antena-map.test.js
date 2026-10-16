import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import express from 'express';
import { generateAntennaMap, validateAntennaMap } from '../src/antenaMapService.js';
import { createTelegramApiRouter } from '../src/telegramApiRouter.js';

test('coverage inputs validate required fields, radius and finite coordinates', () => {
  assert.deepEqual(validateAntennaMap({ lat: '29.0729', lng: '-110.9559', azimuth: '50' }),
    { lat: 29.0729, lng: -110.9559, azimuth: 50, radius: 500 });
  assert.deepEqual(validateAntennaMap({ lat: '29', lng: '-110' }), { lat: 29, lng: -110, azimuth: null, radius: 500 });
  for (const query of [{}, { lat: 'NaN', lng: '0', azimuth: '50' }, { lat: '90', lng: '0', azimuth: '50' },
    { lat: '29', lng: '-110', azimuth: '360' }, { lat: '29', lng: '-110', azimuth: '50', radius: '0' }]) {
    assert.throws(() => validateAntennaMap(query));
  }
});

test('one-antenna PNG renders a sector over only the requested map viewport', async () => {
  const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  const requested = [];
  const image = await generateAntennaMap({ lat: 29.0729, lng: -110.9559, azimuth: 50, radius: 500 }, {
    tileLoader: async (z, x, y) => { requested.push([z, x, y]); return tile; },
  });
  const info = await sharp(image).metadata();
  assert.equal(info.format, 'png');
  assert.equal(info.width, 768);
  assert.equal(info.height, 768);
  assert.ok(requested.length <= 16);
  const { data, info: raw } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => Array.from(data.subarray((y * raw.width + x) * raw.channels, (y * raw.width + x) * raw.channels + 3));
  const inside = pixel(430, 330), outside = pixel(250, 450);
  assert.ok(inside[2] > inside[0]);
  assert.deepEqual(outside, [238, 238, 238]);
  const markerOnly = await generateAntennaMap({ lat: 29.0729, lng: -110.9559 }, { tileLoader: async () => tile });
  const noSectorPixel = await sharp(markerOnly).extract({ left: 430, top: 330, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual(Array.from(noSectorPixel), [238, 238, 238]);
});

test('coverage API requires bot credentials and user authorization, and never queries the database', async (t) => {
  const config = { TELEGRAM_API_TOKEN: 'x'.repeat(32), TELEGRAM_ALLOWED_USER_IDS: '123' };
  let calls = 0;
  const app = express();
  app.use('/api/bot', createTelegramApiRouter({ query: () => { throw new Error('Unexpected DB query'); } }, config,
    async (params) => { calls++; assert.equal(params.azimuth, 50); return Buffer.from('PNG test'); }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/bot/cobertura?lat=29&lng=-110&azimuth=50`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: `Bearer ${config.TELEGRAM_API_TOKEN}`, 'X-Telegram-User-Id': '123' };
  assert.equal((await fetch(url, { headers: { ...headers, 'X-Telegram-User-Id': '456' } })).status, 403);
  assert.equal(calls, 0);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').startsWith('image/png'));
  assert.equal(calls, 1);
});
