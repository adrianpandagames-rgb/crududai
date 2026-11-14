import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { describirCambios, describirRegistro, registroAuditado, registroDeSolicitud } from '../src/auditCambios.js';
import { auditActivity, auditRequestAction } from '../src/auditMiddleware.js';
import { describeAuditAction } from '../src/auditActions.js';
import { presentAuditEntry } from '../src/auditPresentation.js';

test('edits list only the fields that changed, as plain text with an arrow', () => {
  const antes = { Número: '6621234567', NUC: '123/2026', Delito: null, Contraseña: 'hash-a' };
  const despues = { Número: '6629876543', NUC: '123/2026', Delito: 'Robo', Contraseña: 'hash-b' };
  assert.equal(describirCambios('editar', antes, despues),
    'Número: 6621234567 → 6629876543\nDelito: (vacío) → Robo\nContraseña: se cambió');
  assert.equal(describirCambios('editar', antes, antes), 'Sin cambios en los datos.');
  assert.ok(!describirCambios('editar', antes, despues).includes('hash'));
});

test('JSON columns and dates become readable fields', () => {
  const antes = { Preferencias: '{"tema":"claro","avisos":true}', Fecha: new Date('2026-01-02T03:04:05Z') };
  const despues = { Preferencias: '{"tema":"oscuro","avisos":true}', Fecha: new Date('2026-01-02T03:04:05Z') };
  assert.equal(describirCambios('editar', antes, despues), 'Preferencias · tema: claro → oscuro');
});

test('deletions keep the removed values, or say the record is still there', () => {
  const fila = { Archivo: 'sabana.csv', Línea: '6621234567', Filas: 0, Notas: '' };
  assert.equal(describirCambios('eliminar', fila, null), 'Datos eliminados:\nArchivo: sabana.csv\nLínea: 6621234567\nFilas: 0');
  assert.equal(describirCambios('eliminar', fila, fila), 'El registro no se eliminó.');
  assert.equal(describirCambios('eliminar', null, null), null);
  assert.equal(describirCambios('exportar', fila, fila), null);
});

test('the record is named by type, id and first field', () => {
  assert.equal(describirRegistro({ nombre: 'Línea', id: '12' }, { Número: '6621234567' }, null), 'Línea #12 · 6621234567');
  assert.equal(describirRegistro({ nombre: 'Ruta', id: 'a1b2-uuid' }, null, { Archivo: 'ruta.xlsx' }), 'Ruta · ruta.xlsx');
  assert.equal(describirRegistro({ nombre: 'Mi cuenta', id: 7, porSesion: true }, null, null), 'Mi cuenta');
  assert.equal(registroDeSolicitud('/lineas', { numObjetivo: '6621234567', nuc: '1' }), 'numObjetivo: 6621234567');
  assert.equal(registroDeSolicitud('/ruta/importar', {}, [{ originalname: 'a.csv' }]), 'Archivo: a.csv');
  assert.equal(registroDeSolicitud('/tareas/15/comentar', { comentario: 'hola' }), '#15');
  assert.equal(registroDeSolicitud('/otra', {}), null);
});

test('routes across the system map to the record they change', () => {
  const ctx = { pool: { query: async () => [[]] }, userId: 3 };
  const cases = [
    ['/lineas/editar/5', 'Línea', 'editar'], ['/imei/editar/5', 'IMEI', 'editar'], ['/ubicaciones/5/modificar', 'Ubicación', 'editar'],
    ['/perfiles/5/editar', 'Perfil', 'editar'], ['/perfiles/eliminar/5', 'Perfil', 'eliminar'], ['/tareas/5/mover', 'Tarea', 'editar'],
    ['/tareas/eliminar/5', 'Tarea', 'eliminar'], ['/usuarios/5/rol', 'Usuario', 'editar'], ['/cuenta/tema', 'Mi cuenta', 'editar'],
    ['/ruta/eliminar/0f8c-uuid', 'Ruta', 'eliminar'], ['/ruta/exportar-kmz/0f8c-uuid', 'Ruta', 'exportar'],
    ['/georeferenciacion/eliminar/0f8c', 'Georreferenciación', 'eliminar'], ['/imagenes/0f8c/revocar', 'Imagen', 'editar'],
    ['/maigret/eliminar/0f8c', 'Búsqueda Maigret', 'eliminar'], ['/spiderfoot/0f8c/csv', 'Búsqueda SpiderFoot', 'exportar'],
  ];
  for (const [path, nombre, tipo] of cases) {
    const registro = registroAuditado({ query: {} }, path, ctx);
    assert.equal(registro?.nombre, nombre, path);
    assert.equal(registro.tipo, tipo, path);
  }
  const carpeta = registroAuditado({ query: { tipo: 'Recepción' } }, '/metricas/registros/9', ctx);
  assert.equal(carpeta.nombre, 'Recepción');
  assert.equal(registroAuditado({ query: { tipo: 'Inventado' } }, '/metricas/registros/9', ctx), null);
  assert.equal(registroAuditado({ query: {} }, '/lineas/editar/5', { pool: ctx.pool }), null, 'anonymous requests read nothing');
});

test('exports, imports and sign-outs have their own action', () => {
  for (const path of ['/ruta/exportar/x', '/ruta/exportar-xlsx/x', '/limpieza/descargar/x/geo', '/maigret/x/reporte', '/spiderfoot/x/csv', '/auditoria/exportar']) {
    assert.equal(auditRequestAction({ method: 'GET', path, query: {} }), 'EXPORT', path);
  }
  assert.equal(auditRequestAction({ method: 'POST', path: '/auditoria/exportacion' }), null);
  assert.equal(describeAuditAction({ operation: 'EXPORTACION', request_path: '/ruta/exportar-kmz/x' }), 'Exportó ruta (KMZ)');
  assert.equal(describeAuditAction({ operation: 'EXPORTACION', request_path: '/coincidencias' }), 'Exportación');
  assert.equal(describeAuditAction({ operation: 'IMPORTACION', request_path: '/planeacion-geografica/importar' }), 'Importó planeación geográfica');
  assert.equal(describeAuditAction({ operation: 'LOGOUT', request_path: '/logout' }), 'Cierre de sesión');
});

test('the middleware reads the record before the route changes it and logs before → after', async (t) => {
  const store = { numero: '6621234567' };
  const app = express();
  const events = [];
  app.locals.writeAuditLog = (entry) => events.push(entry);
  app.locals.auditPool = { query: async () => [[store.numero === null ? undefined : { Número: store.numero }].filter(Boolean)] };
  app.locals.auditSession = () => ({ userId: 42 });
  app.use(express.urlencoded({ extended: true }));
  app.use(auditActivity);
  app.use((req, res, next) => { req.session = { userId: 42, email: 'usuario@example.com' }; next(); });
  app.post('/lineas/editar/:id', (req, res) => { store.numero = req.body.numObjetivo; res.redirect('/lineas'); });
  app.post('/tareas/eliminar/:id', (req, res) => { store.numero = null; res.redirect('/tareas'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const waitFor = async (count) => { for (let i = 0; i < 50 && events.length < count; i += 1) await new Promise((r) => setTimeout(r, 10)); };

  await fetch(`${base}/lineas/editar/12`, { method: 'POST', body: new URLSearchParams({ numObjetivo: '6629876543' }), redirect: 'manual' });
  await waitFor(1);
  assert.equal(events[0].registro, 'Línea #12 · 6621234567');
  assert.equal(events[0].cambios, 'Número: 6621234567 → 6629876543');
  assert.equal(events[0].userEmail, 'usuario@example.com');

  await fetch(`${base}/tareas/eliminar/3`, { method: 'POST', redirect: 'manual' });
  await waitFor(2);
  assert.equal(events[1].cambios, 'Datos eliminados:\nNúmero: 6629876543');
});

test('the detail under the arrow is plain text, not JSON', () => {
  const entry = presentAuditEntry({
    method: 'POST', request_path: '/lineas/editar/12', registro: 'Línea #12 · 6621234567',
    cambios: 'Número: 6621234567 → 6629876543', operation: 'EDITADO',
    details: JSON.stringify({ metodo: 'POST', datos: { numObjetivo: '6629876543', password: 'x' }, archivos: [{ nombre: 'a.csv', bytes: 2048, tipo: 'text/csv' }] }),
  });
  assert.equal(entry.detalle, [
    'Método: POST', 'Ruta: /lineas/editar/12', 'Registro: Línea #12 · 6621234567', '',
    'Cambios:', '  Número: 6621234567 → 6629876543', '',
    'Datos enviados:', '  numObjetivo: 6629876543', '  password: [OCULTO]', '',
    'Archivos:', '  a.csv (2.0 KB, text/csv)',
  ].join('\n'));
  assert.ok(!entry.detalle.includes('{'));
});
