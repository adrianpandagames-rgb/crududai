import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { normalizarPreferencias, paginaDeInicio, paginasInicioPara, procesarFoto, validarNombre } from '../src/cuentaService.js';
import { createCuentaRouter } from '../src/cuentaRouter.js';
import { createNotificacionesStore } from '../src/notificacionesService.js';

test('preferences fall back to defaults and never keep a start page the role cannot open', () => {
  assert.deepEqual(normalizarPreferencias(null, 'usuario'), { tema: 'sistema', inicio: '/Crud', avisos: true });
  assert.deepEqual(normalizarPreferencias('{"tema":"oscuro","inicio":"/tareas","avisos":false}', 'usuario'),
    { tema: 'oscuro', inicio: '/tareas', avisos: false });
  // UECS cannot open Líneas or IMEI either, and starts on the line file.
  assert.equal(normalizarPreferencias({ inicio: '/tareas' }, 'uecs').inicio, '/ficha');
  assert.equal(normalizarPreferencias({ inicio: '/Crud' }, 'uecs').inicio, '/ficha');
  assert.equal(normalizarPreferencias({ inicio: '/imei' }, 'uecs').inicio, '/ficha');
  assert.equal(normalizarPreferencias(null, 'uecs').inicio, '/ficha');
  assert.equal(normalizarPreferencias({ inicio: '/ficha' }, 'usuario').inicio, '/ficha');
  assert.equal(normalizarPreferencias({ inicio: 'https://example.com' }, 'admin').inicio, '/Crud');
  assert.equal(normalizarPreferencias({ tema: 'rosa' }, 'admin').tema, 'sistema');
  assert.equal(normalizarPreferencias('no es json', 'admin').tema, 'sistema');
  assert.ok(!paginasInicioPara('uecs').some(({ path }) => ['/metricas', '/tareas', '/Crud', '/imei'].includes(path)));
  assert.ok(paginasInicioPara('uecs').some(({ path }) => path === '/ficha'));
  assert.equal(paginaDeInicio({ role: 'uecs' }), '/ficha');
  assert.equal(paginaDeInicio({ role: 'usuario' }), '/Crud');
  assert.equal(paginaDeInicio({ role: 'usuario', preferencias: { inicio: '/ruta' } }), '/ruta');
  // A UECS session that still holds Líneas as start page (opened before the change) must not loop back to it.
  assert.equal(paginaDeInicio({ role: 'uecs', preferencias: { inicio: '/Crud' } }), '/ficha');
});

test('names are optional, trimmed and limited', () => {
  assert.deepEqual(validarNombre('  Ana   María  '), { nombre: 'Ana María' });
  assert.deepEqual(validarNombre('   '), { nombre: null });
  assert.match(validarNombre('x'.repeat(81)).error, /80/);
  assert.match(validarNombre('<script>').error, /< o >/);
});

test('photos are re-encoded as a small square WebP and other files are refused', async () => {
  const png = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#336699' } }).png().toBuffer();
  const { data } = await procesarFoto(png);
  const meta = await sharp(data).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert.equal(meta.exif, undefined);
  assert.match((await procesarFoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).error, /JPG, PNG/);
});

test('notifications keep only internal links and only their owner can open them', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => { calls.push([sql, values]); return [[]]; },
    execute: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.startsWith('SELECT url')) return [values[1] === 5 ? [{ url: '/tareas#tarea-1' }] : []];
      return [{ affectedRows: 1 }];
    },
  };
  const store = createNotificacionesStore(pool);
  await store.crear(5, { titulo: 'Hola', mensaje: 'x', url: '//evil.example' });
  await store.crear(5, { titulo: 'Hola', mensaje: 'x', url: 'javascript:alert(1)' });
  await store.crear(5, { titulo: 'Hola', mensaje: 'x', url: '/ruta?highlight=1' });
  const inserted = calls.filter(([sql]) => sql.startsWith('INSERT')).map(([, values]) => values[3]);
  assert.deepEqual(inserted, [null, null, '/ruta?highlight=1']);
  assert.deepEqual(await store.marcarLeida('1', 5), { url: '/tareas#tarea-1' });
  assert.equal(await store.marcarLeida('1', 6), null);
});

test('Mi cuenta only touches the signed-in person and asks app.js to change the password', async (t) => {
  const saved = { nombre: [], foto: [], preferencias: [] };
  const cuentas = {
    get: async () => ({ nombre: 'Ana', fotoVersion: '', preferencias: { tema: 'sistema', inicio: '/Crud', avisos: true } }),
    setNombre: async (userId, nombre) => saved.nombre.push([userId, nombre]),
    setFoto: async (userId, data) => saved.foto.push([userId, data && data.length > 0]),
    setPreferencias: async (userId, value) => saved.preferencias.push([userId, value]),
    getFoto: async () => null,
  };
  const opened = [];
  const notificaciones = {
    listar: async () => ({ notificaciones: [{ id: 3, titulo: 'Nueva tarea asignada', mensaje: 'Revisar', url: '/tareas', leida: false, creada: 'hoy' }], total: 1, currentPage: 1, totalPages: 1 }),
    marcarLeida: async (id, userId) => { opened.push([id, userId]); return id === '3' ? { url: '/tareas' } : null; },
    marcarTodas: async () => {},
    eliminarLeidas: async () => {},
  };
  const passwordCalls = [];
  const cambiarContrasena = async (req, res, values) => {
    passwordCalls.push(values);
    return values.actual === 'correcta1' ? { warning: null } : { error: 'La contraseña actual no es correcta.' };
  };

  const app = express();
  app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
  app.set('view engine', 'ejs');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const session = { userId: 5, role: 'usuario', email: 'ana@example.com' };
  app.use((req, res, next) => {
    req.session = req.headers['x-anon'] ? undefined : session;
    res.locals.currentUser = req.session ? { id: 5, role: 'usuario', email: session.email, nombre: 'Ana', noLeidas: 1 } : undefined;
    next();
  });
  app.use('/cuenta', createCuentaRouter(null, { cuentas, notificaciones, cambiarContrasena }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/cuenta`;
  const post = (path, fields, init = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields), ...init });
  const page = async () => (await fetch(base)).text();

  assert.equal((await fetch(base, { redirect: 'manual', headers: { 'x-anon': '1' } })).headers.get('location'), '/');
  assert.match(await page(), /Mi cuenta[\s\S]*value="Ana"/);

  // The user id never comes from the form.
  await post('/nombre', { nombre: '  Ana  López ', userId: '9' });
  assert.deepEqual(saved.nombre, [[5, 'Ana López']]);
  assert.match(await page(), /Nombre actualizado/);

  await post('/preferencias', { tema: 'oscuro', inicio: '/metricas', avisos: '0' });
  assert.deepEqual(saved.preferencias.at(-1), [5, { tema: 'oscuro', inicio: '/metricas', avisos: false }]);

  const tema = await fetch(`${base}/tema`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tema: 'light' }) });
  assert.equal(tema.status, 204);
  assert.equal(saved.preferencias.at(-1)[1].tema, 'claro');

  const form = new FormData();
  form.append('foto', new Blob([await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).jpeg().toBuffer()]), 'yo.jpg');
  await fetch(`${base}/foto`, { method: 'POST', redirect: 'manual', body: form });
  const fake = new FormData();
  fake.append('foto', new Blob([Buffer.from('no es imagen')]), 'yo.jpg');
  await fetch(`${base}/foto`, { method: 'POST', redirect: 'manual', body: fake });
  assert.deepEqual(saved.foto, [[5, true]]);
  assert.match(await page(), /JPG, PNG, WebP o GIF\./);

  await post('/contrasena', { currentPassword: 'x', password: 'corta', confirmPassword: 'corta' });
  await post('/contrasena', { currentPassword: 'x', password: 'nueva-clave', confirmPassword: 'otra-clave' });
  assert.equal(passwordCalls.length, 0);
  await post('/contrasena', { currentPassword: 'incorrecta', password: 'nueva-clave', confirmPassword: 'nueva-clave' });
  assert.match(await page(), /actual no es correcta/);
  await post('/contrasena', { currentPassword: 'correcta1', password: 'nueva-clave', confirmPassword: 'nueva-clave' });
  assert.match(await page(), /Contraseña actualizada/);
  assert.equal(passwordCalls.length, 2);

  assert.match(await (await fetch(`${base}/notificaciones`)).text(), /Nueva tarea asignada[\s\S]*sin leer/);
  assert.equal((await post('/notificaciones/3/abrir', {})).headers.get('location'), '/tareas');
  assert.equal((await post('/notificaciones/4/abrir', {})).headers.get('location'), '/cuenta/notificaciones');
  assert.deepEqual(opened, [['3', 5], ['4', 5]]);
});
