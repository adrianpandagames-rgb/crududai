// Regression tests for the fixes made after the security audit (run-1 of the security-audit skill).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import { isPublicAddress, modesFor, parseTarget } from '../src/spiderfootService.js';
import { createSpiderfootRouter } from '../src/spiderfootRouter.js';
import { MaigretQueueFullError, createMaigretSearches } from '../src/maigretRouter.js';
import { csvEscape, processRutaCsv, createRutaCsv, readRutaXlsxRows } from '../src/rutaService.js';
import { readXlsxSheets } from '../src/perfilesService.js';
import { XLSX_LIMITS, XlsxTooLargeError, declaredInflatedSize, readWorkbook } from '../src/xlsxSafe.js';
import { createPublicCopy } from '../src/imageService.js';
import { MAX_LIST_BYTES, download, suspiciousChange } from '../src/nombresRouter.js';
import { PHONE_LIMITS, resetPhoneValidationUsage, validatePhoneNumber } from '../src/phoneValidation.js';
import { createTelegramApiRouter } from '../src/telegramApiRouter.js';
import { telegramTestConfig, withLinkedTelegramUsers } from './support/telegram-auth.js';

test('SpiderFoot refuses loopback, private, link-local and reserved targets but accepts public ones', () => {
  for (const [type, value] of [['ip', '189.203.10.5'], ['ip', '8.8.8.8'], ['ip', '2606:4700:10::ac42:93f3'], ['red', '189.203.10.0/24'], ['red', '2606:4700::/48']]) {
    assert.ok(!parseTarget(type, { objetivo: value }).error, `${type} ${value} should be accepted`);
  }
  for (const [type, value] of [['ip', '127.0.0.1'], ['ip', '169.254.169.254'], ['ip', '10.1.2.3'], ['ip', '172.16.0.9'], ['ip', '192.168.1.1'],
    ['ip', '100.64.1.1'], ['ip', '0.0.0.0'], ['ip', '::1'], ['ip', '::ffff:127.0.0.1'], ['ip', 'fe80::1'], ['ip', 'fd00::1'],
    ['red', '10.0.5.7/16'], ['red', '172.31.0.0/16'], ['red', '127.0.0.0/16']]) {
    assert.match(parseTarget(type, { objetivo: value }).error ?? '', /públicas/, `${type} ${value} should be refused`);
  }
  assert.equal(isPublicAddress('203.0.114.1'), true);
});

test('only administrators may start an active (completa) SpiderFoot search', async (t) => {
  assert.deepEqual(Object.keys(modesFor({ isAdmin: false })), ['rapida', 'normal']);
  assert.ok(Object.hasOwn(modesFor({ isAdmin: true }), 'completa'));
  const queued = [];
  const searches = { initialize: async () => {}, enqueue: async (session, job) => { queued.push(job); } };
  let session = { userId: 2, role: 'uecs', isAdmin: false };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = session; next(); });
  app.use('/spiderfoot', createSpiderfootRouter({}, { searches }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/spiderfoot/buscar`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body) });
  const refused = await post({ tipo: 'dominio', objetivo: 'ejemplo.com.mx', modo: 'completa' });
  assert.match(decodeURIComponent(refused.headers.get('location')), /administrador/);
  assert.equal(queued.length, 0);
  await post({ tipo: 'dominio', objetivo: 'ejemplo.com.mx', modo: 'rapida' });
  session = { userId: 1, role: 'admin', isAdmin: true };
  await post({ tipo: 'dominio', objetivo: 'ejemplo.com.mx', modo: 'completa' });
  assert.deepEqual(queued.map((job) => job.mode), ['rapida', 'completa']);
});

test('one person cannot take over the shared OSINT queue', async () => {
  const pool = { query: async () => [[]], execute: async () => [{ affectedRows: 1 }] };
  const searches = createMaigretSearches(pool, { runSearch: () => new Promise(() => {}) });
  const a = { userId: 1, role: 'uecs' };
  const b = { userId: 2, role: 'usuario' };
  await searches.enqueue(a, { username: 'uno', mode: 'completa' });
  await assert.rejects(searches.enqueue(a, { username: 'dos', mode: 'completa' }), (error) => error instanceof MaigretQueueFullError && /completa/.test(error.message));
  for (let i = 0; i < 5; i += 1) await searches.enqueue(a, { username: `rapida${i}`, mode: 'rapida' });
  await assert.rejects(searches.enqueue(a, { username: 'otra', mode: 'rapida' }), /Ya tienes 6/);
  // Someone else still gets a place.
  assert.ok(await searches.enqueue(b, { username: 'ajeno', mode: 'rapida' }));
});

test('CSV exports neutralize formulas but keep negative coordinates as numbers, and quote the active delimiter', () => {
  assert.equal(csvEscape('-110.9'), '-110.9');
  assert.equal(csvEscape('29.1'), '29.1');
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvEscape('+52 662'), "'+52 662");
  assert.equal(csvEscape('a;b', ';'), '"a;b"');
  const rows = processRutaCsv('latitud,longitud\r\n29.1,-110.9\r\n', [{
    idUbicacion: 1, latitude: 29.1, longitude: -110.9, ubicacion: '=HYPERLINK("https://example.invalid","x")', lugar: 'L',
  }]);
  const line = createRutaCsv(rows).split('\r\n').find((text) => text.includes('HYPERLINK'));
  assert.ok(line.includes(`"'=HYPERLINK(`) && line.includes('-110.9'));
});

// An .xlsx whose sheet XML claims a huge range, built by editing the ZIP (writing it normally would walk the range).
const workbookWithDimension = (aoa, ref) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
  const cfb = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = cfb.FileIndex[cfb.FullPaths.findIndex((name) => /sheet1\.xml$/.test(name))];
  entry.content = Buffer.from(Buffer.from(entry.content).toString('utf8').replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${ref}"/>`));
  entry.size = entry.content.length;
  return Buffer.from(XLSX.CFB.write(cfb, { fileType: 'zip', type: 'buffer' }));
};

test('an uploaded workbook cannot make the parser walk the range it claims', () => {
  const buffer = workbookWithDimension([['latitud', 'longitud'], ['29.1', '-110.9']], 'A1:XFD1048576');
  const started = Date.now();
  assert.deepEqual(readRutaXlsxRows(buffer), [['latitud', 'longitud'], ['29.1', '-110.9']]);
  assert.equal(readXlsxSheets(buffer)[0].length, 2);
  assert.ok(Date.now() - started < 5000, 'bounded parse should be quick');
  assert.ok(declaredInflatedSize(buffer) < XLSX_LIMITS.inflatedBytes);
});

test('a workbook that inflates beyond the limit is refused before parsing', () => {
  const buffer = workbookWithDimension([['a']], 'A1:A1');
  // Forge the central directory's uncompressed size of the first entry to 300 MB.
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(300 * 1024 * 1024, central + 24);
  assert.throws(() => readWorkbook(buffer, { type: 'buffer' }), XlsxTooLargeError);
});

test('the public JPEG copy ends at the primary image and keeps no EXIF', async () => {
  const make = (gps) => sharp({ create: { width: 16, height: 16, channels: 3, background: '#369' } })
    .jpeg({ progressive: gps })
    .withExif({ IFD0: { Make: 'X' }, ...(gps ? { GPS: { GPSLatitudeRef: 'N', GPSLatitude: '29/1 5/1 0/1' } } : {}) })
    .toBuffer();
  const primary = await make(false);
  const appended = Buffer.concat([primary, await make(true)]);
  const copy = createPublicCopy(appended, 'jpeg');
  assert.equal(copy.stripped, true);
  assert.equal(copy.buffer.indexOf(Buffer.from('Exif\0\0')), -1);
  assert.equal(copy.buffer.indexOf(Buffer.from([0xff, 0xd8]), 2), -1, 'no second image may remain');
  assert.equal((await sharp(copy.buffer).metadata()).width, 16);
  const progressive = createPublicCopy(await make(true), 'jpeg');
  assert.equal(progressive.stripped, true);
  assert.equal(progressive.buffer.indexOf(Buffer.from('Exif\0\0')), -1);
});

test('official list downloads refuse redirects and oversize bodies, and big swings keep the stored list', async () => {
  let options;
  const small = async (url, opts) => { options = opts; return new Response('No,RFC,\n1,AAA'); };
  assert.equal(await download(small, 'http://example.invalid/x.csv', 'utf-8'), 'No,RFC,\n1,AAA');
  assert.equal(options.redirect, 'error');
  const declared = async () => new Response('x', { headers: { 'content-length': String(MAX_LIST_BYTES + 1) } });
  await assert.rejects(download(declared, 'http://example.invalid', 'utf-8'), /más grande/);
  const streamed = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
  }));
  await assert.rejects(download(streamed, 'http://example.invalid', 'utf-8'), /más grande/);
  assert.equal(suspiciousChange(10000, 10200), false);
  assert.equal(suspiciousChange(10000, 4000), true);
  assert.equal(suspiciousChange(10000, 40000), true);
  assert.equal(suspiciousChange(0, 5000), false);
});

test('phone validation has a per-person daily allowance and answers repeats from memory', async () => {
  resetPhoneValidationUsage();
  process.env.PHONE_VALIDATION_ACCESS_KEY = 'dummy';
  let calls = 0;
  const request = async () => { calls += 1; return { statusCode: 200, data: { valid: true } }; };
  assert.deepEqual(await validatePhoneNumber('6621234567', { userId: 7, request }), { valid: true });
  await validatePhoneNumber('6621234567', { userId: 7, request });
  assert.equal(calls, 1, 'a repeated number must not spend another lookup');
  for (let i = 1; i < PHONE_LIMITS.perUser; i += 1) await validatePhoneNumber(`66200000${String(i).padStart(2, '0')}`, { userId: 7, request });
  await assert.rejects(validatePhoneNumber('6629999999', { userId: 7, request }), (error) => error.status === 429);
  assert.deepEqual(await validatePhoneNumber('6629999999', { userId: 8, request }), { valid: true });
  resetPhoneValidationUsage();
  delete process.env.PHONE_VALIDATION_ACCESS_KEY;
});

test('bot geocoding has a daily allowance per linked user', async (t) => {
  const config = { ...telegramTestConfig('x'.repeat(32)), BOT_GEOCODING_DAILY_LIMIT: '2' };
  let calls = 0;
  const app = express();
  app.use('/api/bot', createTelegramApiRouter(withLinkedTelegramUsers({}, config, ['123']), config, undefined, async () => {
    calls += 1;
    return { rows: [], status: 'SIN_RESULTADOS' };
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/bot/cobertura/ubicacion`;
  const headers = { Authorization: `Bearer ${config.TELEGRAM_API_TOKEN}`, 'X-Telegram-User-Id': '123', 'Content-Type': 'application/json' };
  const ask = () => fetch(url, { method: 'POST', headers, body: JSON.stringify({ lat: '0.5', lng: '-150.5' }) });
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 200);
  const limited = await ask();
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /límite de 2/);
  assert.equal(calls, 2);
});
