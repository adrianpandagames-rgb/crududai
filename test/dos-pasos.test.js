import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import {
  MAX_INTENTOS_PENDIENTE, PENDIENTE_COOKIE, configWebauthn, createDosPasosStore, createPendientes, generarCodigo, normalizarCodigo,
} from '../src/dosPasosService.js';
import { createDosPasosCuentaRouter, createVerificacionRouter } from '../src/dosPasosRouter.js';

const config = { origin: 'https://app.example.test', rpID: 'app.example.test', rpName: 'Prueba' };
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const b64 = (bytes) => isoBase64URL.fromBuffer(new Uint8Array(bytes));

// A software passkey: a P-256 key pair that answers like a phone after the fingerprint check.
function crearAutenticador({ origin = config.origin, rpID = config.rpID } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const counterBytes = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
  return {
    id: b64(credId),
    registro(challenge) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      // User present + user verified + attested credential data.
      const authData = Buffer.concat([sha256(rpID), Buffer.from([0x45]), counterBytes(0), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
      return {
        id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData('webauthn.create', challenge)), attestationObject: b64(attestationObject), transports: ['internal'] },
      };
    },
    firmar(challenge, { verificado = true } = {}) {
      counter += 1;
      const authData = Buffer.concat([sha256(rpID), Buffer.from([verificado ? 0x05 : 0x01]), counterBytes(counter)]);
      const cd = clientData('webauthn.get', challenge);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(cd)]), privateKey);
      return {
        id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(signature) },
      };
    },
  };
}

function storeEnMemoria() {
  const creds = [];
  const codigos = new Map();
  return {
    creds,
    activo: async (userId) => creds.some((c) => c.userId === userId),
    credenciales: async (userId) => creds.filter((c) => c.userId === userId)
      .map(({ id, publicKey, counter, transports }) => ({ id, publicKey, counter, transports })),
    guardar: async (userId, c) => { creds.push({ userId, ...c, publicKey: new Uint8Array(c.publicKey) }); },
    registrarUso: async (_userId, id, counter) => { creds.find((c) => c.id === id).counter = counter; },
    nuevosCodigos: async (userId) => {
      const lista = Array.from({ length: 10 }, generarCodigo);
      codigos.set(userId, new Set(lista.map(normalizarCodigo)));
      return lista;
    },
    usarCodigo: async (userId, valor) => {
      const n = normalizarCodigo(valor);
      return Boolean(n && codigos.get(userId)?.delete(n));
    },
  };
}

async function servidor(t, { obligatorio = false } = {}) {
  const store = storeEnMemoria();
  const pendientes = createPendientes();
  const session = { userId: 5, email: 'ana@example.com' };
  const completados = [];
  const fallos = [];
  const avisos = [];
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', './views');
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/verificar', createVerificacionRouter({
    store, pendientes, config,
    esperaMs: () => 0,
    completarLogin: async (_req, _res, pendiente, metodo) => { completados.push([pendiente.userId, metodo]); return '/inicio'; },
    registrarFallo: (_req, pendiente, motivo) => fallos.push([pendiente.userId, motivo]),
  }));
  app.use('/cuenta/dos-pasos', (req, _res, next) => { req.session = session; next(); }, createDosPasosCuentaRouter({
    store, config, obligatorio, avisar: (userId, aviso) => avisos.push([userId, aviso.message]),
    confirmarContrasena: async (_req, password) => (password === 'correcta' ? null : 'La contraseña actual no es correcta.'),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, { cookie, origin = base, form = false } = {}) => fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Origin: origin,
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(cookie ? { Cookie: `${PENDIENTE_COOKIE}=${cookie}` } : {}),
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body || {}),
  });
  const pendiente = () => pendientes.crear({ userId: 5, email: 'ana@example.com', credentialHash: 'hash' });
  return { store, pendientes, session, completados, fallos, avisos, post, pendiente };
}

async function registrar(ctx, autenticador, nombre = 'iPhone') {
  const options = await (await ctx.post('/cuenta/dos-pasos/opciones')).json();
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  return ctx.post('/cuenta/dos-pasos', { nombre, respuesta: autenticador.registro(options.challenge) });
}

test('passkeys are tied to the HTTPS domain and never to an IP address', () => {
  assert.deepEqual(configWebauthn({ PUBLIC_BASE_URL: 'https://app.example.mx/ruta', NODE_ENV: 'production' }),
    { origin: 'https://app.example.mx', rpID: 'app.example.mx', rpName: 'CRUDUDAI' });
  assert.equal(configWebauthn({ PUBLIC_BASE_URL: 'https://203.0.113.10', NODE_ENV: 'production' }), null);
  assert.equal(configWebauthn({ PUBLIC_BASE_URL: 'http://app.example.mx', NODE_ENV: 'production' }), null);
  assert.equal(configWebauthn({ NODE_ENV: 'production' }), null);
  assert.equal(configWebauthn({ PUBLIC_BASE_URL: 'https://app.example.mx', WEBAUTHN_RP_ID: 'otro.mx', NODE_ENV: 'production' }), null);
  assert.equal(configWebauthn({ PUBLIC_BASE_URL: 'https://app.example.mx', WEBAUTHN_RP_ID: 'example.mx', NODE_ENV: 'production' }).rpID, 'example.mx');
  assert.equal(configWebauthn({ HTTPS_PORT: '3443' }).origin, 'https://localhost:3443');
});

test('recovery codes read the same with or without dash or capitals, and only valid symbols pass', () => {
  const codigo = generarCodigo();
  assert.match(codigo, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(normalizarCodigo(codigo.toLowerCase().replace('-', ' ')), codigo.replace('-', ''));
  assert.equal(normalizarCodigo('ABCDE-FGHI0'), null);
  assert.equal(normalizarCodigo('ABC'), null);
});

test('the store keeps only code hashes and spends each code once', async () => {
  const calls = [];
  let usado = false;
  const pool = {
    query: async (sql, values) => { calls.push([sql, values]); return [{}]; },
    execute: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.startsWith('UPDATE codigos_recuperacion')) { const r = usado ? 0 : 1; usado = true; return [{ affectedRows: r }]; }
      return [{ affectedRows: 1 }];
    },
  };
  const store = createDosPasosStore(pool);
  const codigos = await store.nuevosCodigos(7);
  assert.equal(codigos.length, 10);
  const guardados = calls.find(([sql]) => sql.startsWith('INSERT INTO codigos_recuperacion'))[1][0];
  assert.ok(guardados.every(([userId, hash]) => userId === 7 && /^[0-9a-f]{64}$/.test(hash)));
  assert.ok(!JSON.stringify(calls).includes(codigos[0].replace('-', '')));
  assert.equal(await store.usarCodigo(7, codigos[0]), true);
  assert.equal(await store.usarCodigo(7, codigos[0]), false);
  assert.equal(await store.usarCodigo(7, 'no es un código'), false);
});

test('before the migration nobody has the second step, but other database errors still fail', async () => {
  const sinTabla = Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' });
  assert.equal(await createDosPasosStore({ execute: async () => { throw sinTabla; } }).activo(1), false);
  await assert.rejects(createDosPasosStore({ execute: async () => { throw new Error('caída'); } }).activo(1), /caída/);
});

test('pending sign-ins expire after their time', () => {
  let ahora = 0;
  const pendientes = createPendientes({ ttlMs: 1000, now: () => ahora });
  const token = pendientes.crear({ userId: 1 });
  assert.equal(pendientes.obtener(token).userId, 1);
  ahora = 1001;
  assert.equal(pendientes.obtener(token), null);
  assert.equal(pendientes.obtener(null), null);
});

test('a registered passkey completes the sign-in, and a replayed or unverified answer does not', async (t) => {
  const ctx = await servidor(t);
  const telefono = crearAutenticador();
  const registro = await registrar(ctx, telefono);
  assert.equal(registro.status, 200);
  assert.equal(ctx.store.creds.length, 1);
  assert.equal(ctx.store.creds[0].nombre, 'iPhone');
  assert.equal(ctx.session.flash.codigos.length, 10, 'the first passkey comes with recovery codes');
  assert.equal(ctx.avisos.length, 1);

  const token = ctx.pendiente();
  const options = await (await ctx.post('/verificar/opciones', {}, { cookie: token })).json();
  assert.deepEqual(options.allowCredentials.map(({ id }) => id), [telefono.id]);
  const firmada = telefono.firmar(options.challenge);
  const ok = await ctx.post('/verificar/passkey', { respuesta: firmada }, { cookie: token });
  assert.deepEqual(await ok.json(), { redirect: '/inicio' });
  assert.deepEqual(ctx.completados, [[5, 'Llave de acceso']]);
  assert.equal(ctx.pendientes.obtener(token), null, 'the pending sign-in is used up');

  // The same signed answer cannot open a second sign-in.
  const otro = ctx.pendiente();
  await ctx.post('/verificar/opciones', {}, { cookie: otro });
  const repetida = await ctx.post('/verificar/passkey', { respuesta: firmada }, { cookie: otro });
  assert.equal(repetida.status, 401);

  // Without the fingerprint or PIN check the answer is refused.
  const sinHuella = await ctx.post('/verificar/opciones', {}, { cookie: otro }).then((r) => r.json());
  const rechazada = await ctx.post('/verificar/passkey', { respuesta: telefono.firmar(sinHuella.challenge, { verificado: false }) }, { cookie: otro });
  assert.equal(rechazada.status, 401);
  assert.equal(ctx.completados.length, 1);
  assert.equal(ctx.fallos.length, 2);
});

test('a passkey made for another site is refused', async (t) => {
  const ctx = await servidor(t);
  const options = await (await ctx.post('/cuenta/dos-pasos/opciones')).json();
  const falsa = crearAutenticador({ origin: 'https://phishing.example', rpID: 'phishing.example' });
  const res = await ctx.post('/cuenta/dos-pasos', { nombre: 'x', respuesta: falsa.registro(options.challenge) });
  assert.equal(res.status, 400);
  assert.equal(ctx.store.creds.length, 0);
});

test('recovery codes work once and five wrong tries end the pending sign-in', async (t) => {
  const ctx = await servidor(t);
  await registrar(ctx, crearAutenticador());
  const [codigo] = ctx.session.flash.codigos;

  const token = ctx.pendiente();
  const bueno = await ctx.post('/verificar/codigo', { codigo }, { cookie: token, form: true });
  assert.equal(bueno.status, 303);
  assert.equal(bueno.headers.get('location'), '/inicio');
  assert.deepEqual(ctx.completados, [[5, 'Código de recuperación']]);

  const otro = ctx.pendiente();
  const usado = await ctx.post('/verificar/codigo', { codigo }, { cookie: otro, form: true });
  assert.equal(usado.status, 401);
  for (let i = 1; i < MAX_INTENTOS_PENDIENTE; i += 1) await ctx.post('/verificar/codigo', { codigo: 'AAAAA-AAAAA' }, { cookie: otro, form: true });
  assert.equal(ctx.pendientes.obtener(otro), null);
  assert.equal(ctx.fallos.length, MAX_INTENTOS_PENDIENTE);
  assert.equal(ctx.completados.length, 1);
});

test('the second step refuses other origins and missing pending sign-ins', async (t) => {
  const ctx = await servidor(t);
  const token = ctx.pendiente();
  assert.equal((await ctx.post('/verificar/opciones', {}, { cookie: token, origin: 'https://evil.example' })).status, 403);
  assert.equal((await ctx.post('/verificar/opciones', {}, { cookie: 'inventado' })).status, 401);
  assert.equal((await ctx.post('/verificar/codigo', { codigo: 'x' }, { form: true })).headers.get('location'), '/');
});

test('removing a passkey or replacing the codes asks for the password', async (t) => {
  const ctx = await servidor(t);
  const removidos = [];
  ctx.store.eliminar = async (userId, id) => { removidos.push([userId, id]); return { eliminada: true, quedan: false }; };
  const mal = await ctx.post('/cuenta/dos-pasos/1/eliminar', { currentPassword: 'mala' }, { form: true });
  assert.equal(mal.status, 303);
  assert.match(ctx.session.flash.error, /contraseña actual/);
  assert.deepEqual(removidos, []);
  await ctx.post('/cuenta/dos-pasos/1/eliminar', { currentPassword: 'correcta' }, { form: true });
  assert.deepEqual(removidos, [[5, 1]]);
  assert.match(ctx.session.flash.message, /desactivada/);
});

test('when it is required, registering unlocks the session and the last passkey cannot be removed', async (t) => {
  const ctx = await servidor(t, { obligatorio: true });
  const removidos = [];
  ctx.store.eliminar = async (userId, id) => { removidos.push([userId, id]); return { eliminada: true, quedan: true }; };
  assert.equal(ctx.session.dosPasosActivo, undefined);
  await registrar(ctx, crearAutenticador(), 'Celular');
  assert.equal(ctx.session.dosPasosActivo, true);

  await ctx.post('/cuenta/dos-pasos/1/eliminar', { currentPassword: 'correcta' }, { form: true });
  assert.match(ctx.session.flash.error, /obligatoria/);
  assert.deepEqual(removidos, []);

  await registrar(ctx, crearAutenticador(), 'PC');
  await ctx.post('/cuenta/dos-pasos/1/eliminar', { currentPassword: 'correcta' }, { form: true });
  assert.deepEqual(removidos, [[5, 1]]);
});
