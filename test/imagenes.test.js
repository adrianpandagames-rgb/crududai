import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import exifr from 'exifr';
import { createPublicCopy, detectImageType, readImageMetadata, reverseSearchLinks } from '../src/imageService.js';
import { createImagenesRouter, createPublicImageRouter } from '../src/imagenesRouter.js';

// A 64x48 photo tagged as a Samsung SM-A515F, taken 2026-09-14 21:37:05 at 29.0729, -110.9559.
const JPEG_WITH_GPS = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QE4RXhpZgAATU0AKgAAAAgABgEPAAIAAAAIAAAAVgEQAAIAAAAJAAAAXgExAAIAAAAKAAAAZwEyAAIAAAAUAAAAcYdpAAQAAAABAAAAhYglAAQAAAABAAAAugAAAABTYW1zdW5nAFNNLUE1MTVGAEE1MTVGWFhVNQAyMDI2OjA5OjE0IDIxOjM3OjA1AAACkAMAAgAAABQAAACfkBEAAgAAAAcAAACzMjAyNjowOToxNCAyMTozNzowNQAtMDc6MDAAAAUAAQACAAAAAk4AAAAAAgAFAAAAAwAAAPgAAwACAAAAAlcAAAAABAAFAAAAAwAAARAABgAFAAAAAQAAASgAAAAdAAAAAQAAAAQAAAABAAAIxAAAAGQAAABuAAAAAQAAADkAAAABAAAITAAAAGQAAADSAAAAAf/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIADAAQAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AJ6KKK+QPqgooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z', 'base64');
// A PNG carrying the text chunk "Comment: texto oculto en png".
const PNG_WITH_TEXT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAG3RFWHRDb21tZW50AHRleHRvIG9jdWx0byBlbiBwbmchEij2AAAAaElEQVR4nNXOQREAIAzAsFI1SEQishCxB9coyLpnUyZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQD0dcByAJpE10AAAAASUVORK5CYII=', 'base64');

test('image type comes from the file signature', () => {
  assert.equal(detectImageType(JPEG_WITH_GPS), 'jpeg');
  assert.equal(detectImageType(PNG_WITH_TEXT), 'png');
  assert.equal(detectImageType(Buffer.from('GIF89a......')), 'gif');
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(detectImageType(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0')), 'heic');
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(detectImageType(Buffer.from('no es imagen')), null);
});

test('metadata keeps the device date as recorded and reads the GPS position', async () => {
  const metadata = await readImageMetadata(JPEG_WITH_GPS);
  assert.deepEqual(metadata.gps, { latitude: 29.0729, longitude: -110.9559 });
  const summary = Object.fromEntries(metadata.summary.map((field) => [field.label, field.value]));
  assert.equal(summary['Fecha y hora de la toma'], '2026-09-14 21:37:05');
  assert.equal(summary['Zona horaria de la toma'], '-07:00');
  assert.equal(summary.Marca, 'Samsung');
  assert.equal(summary.Modelo, 'SM-A515F');
  assert.equal(summary['Altitud (m)'], '210');
  const empty = await readImageMetadata(Buffer.from('no es imagen'));
  assert.deepEqual(empty, { summary: [], gps: null, all: [] });
});

test('the public copy drops EXIF and text chunks but keeps a valid image', async () => {
  const jpeg = createPublicCopy(JPEG_WITH_GPS, 'jpeg');
  assert.equal(jpeg.stripped, true);
  assert.equal(detectImageType(jpeg.buffer), 'jpeg');
  assert.ok(jpeg.buffer.length < JPEG_WITH_GPS.length);
  assert.equal(await exifr.parse(jpeg.buffer, { gps: true, tiff: true, exif: true, xmp: true, iptc: true }), undefined);
  assert.deepEqual(jpeg.buffer.subarray(-2), Buffer.from([0xff, 0xd9]));

  const png = createPublicCopy(PNG_WITH_TEXT, 'png');
  assert.equal(png.stripped, true);
  assert.ok(!png.buffer.includes('texto oculto'));
  assert.ok(png.buffer.includes('IEND'));

  assert.equal(createPublicCopy(Buffer.from('GIF89a......'), 'gif').stripped, false);
});

test('reverse search links carry the public address encoded', () => {
  const links = reverseSearchLinks('https://app.example/imagen-publica/abc.jpg');
  assert.deepEqual(links.map((link) => link.name), ['Google Lens', 'Yandex', 'Bing', 'TinEye']);
  for (const link of links) assert.ok(link.href.includes(encodeURIComponent('https://app.example/imagen-publica/abc.jpg')));
});

test('uploads are stored for the uploader group and the public link serves only the clean copy', async (t) => {
  const executed = [];
  const token = 'a'.repeat(64);
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      executed.push({ sql, values });
      if (sql.includes('WHERE public_token = ? AND public_expires_at > NOW()')) {
        return values[0] === token ? [[{ image_type: 'jpeg', public_image: Buffer.from('limpia') }]] : [[]];
      }
      if (sql.startsWith('SELECT')) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const app = express();
  app.set('views', new URL('../views', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  app.set('view engine', 'ejs');
  app.use((req, res, next) => {
    const role = req.headers['x-role'];
    req.session = role ? { userId: 9, role, isAdmin: role === 'admin' } : undefined;
    res.locals.currentUser = req.session ? { ...req.session } : undefined;
    next();
  });
  app.use('/imagenes', createImagenesRouter(pool, { publicBaseUrl: 'https://app.example' }));
  app.use('/imagen-publica', createPublicImageRouter(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (buffer, name) => {
    const body = new FormData();
    body.append('imagen', new Blob([buffer]), name);
    return fetch(`${base}/imagenes/subir`, { method: 'POST', body, redirect: 'manual', headers: { 'x-role': 'uecs' } });
  };

  assert.equal((await fetch(`${base}/imagenes`, { redirect: 'manual' })).headers.get('location'), '/');

  const rejected = await upload(Buffer.from('<svg></svg>'), 'foto.jpg');
  assert.match(new URL(rejected.headers.get('location'), base).searchParams.get('message'), /no es una imagen/);

  const accepted = await upload(JPEG_WITH_GPS, 'foto.jpg');
  assert.match(accepted.headers.get('location'), /^\/imagenes\/[0-9a-f-]{36}$/);
  const insert = executed.find(({ sql }) => sql.startsWith('INSERT INTO imagen_busquedas'));
  const [, userId, group, name, type, size, sha256, , original, publicCopy, stripped, metadata, hasGps, publicToken] = insert.values;
  assert.deepEqual([userId, group, name, type, size], [9, 'uecs', 'foto.jpg', 'jpeg', JPEG_WITH_GPS.length]);
  assert.equal(sha256.length, 64);
  assert.ok(original.equals(JPEG_WITH_GPS));
  assert.ok(publicCopy.length < original.length);
  assert.equal(stripped, 1);
  assert.equal(hasGps, 1);
  assert.equal(JSON.parse(metadata).gps.latitude, 29.0729);
  assert.match(publicToken, /^[0-9a-f]{64}$/);

  const served = await fetch(`${base}/imagen-publica/${token}.jpg`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.equal(served.headers.get('x-robots-tag'), 'noindex, noimageindex, nofollow');
  assert.equal(await served.text(), 'limpia');
  assert.equal((await fetch(`${base}/imagen-publica/${'b'.repeat(64)}.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/imagen-publica/no-valido`)).status, 404);

  for (const [role, expected] of [['uecs', ['uecs']], ['usuario', ['general']], ['admin', []]]) {
    executed.length = 0;
    assert.equal((await fetch(`${base}/imagenes`, { headers: { 'x-role': role } })).status, 200);
    const list = executed.find(({ sql }) => sql.startsWith('SELECT i.image_uuid AS id, i.original_name AS name'));
    assert.deepEqual(list.values, expected, role);
  }
});
