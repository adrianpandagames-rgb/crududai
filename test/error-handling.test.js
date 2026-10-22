import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { forwardAsyncErrors, handleErrors, GENERIC_ERROR_MESSAGE } from '../src/errorHandling.js';

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

const buildApp = () => {
  const app = forwardAsyncErrors(express());
  const router = forwardAsyncErrors(express.Router());
  app.set('views', fileURLToPath(new URL('../views/', import.meta.url)));
  app.set('view engine', 'ejs');
  router.get('/api/falla', async () => { throw new Error('detalle interno de SQL'); });
  router.get('/api/invalido', async () => {
    const error = new Error('Número inválido.');
    error.status = 400;
    throw error;
  });
  router.get('/pagina', async () => { throw new Error('detalle interno'); });
  app.use('/', router);
  app.use(handleErrors);
  return app;
};

test('async rejections reach the error handler and hide internal details', async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const server = await listen(buildApp());
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/falla`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: GENERIC_ERROR_MESSAGE });

  const page = await fetch(`${base}/pagina`, { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 500);
  const html = await page.text();
  assert.match(html, /Ocurrió un error interno/);
  assert.doesNotMatch(html, /detalle interno/);
});

test('client errors keep their status and message', async (t) => {
  const server = await listen(buildApp());
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/invalido`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Número inválido.' });
});
