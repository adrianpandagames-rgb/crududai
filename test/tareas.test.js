import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  ESTADOS, ESTADO_LABELS, antiguedadOf, createTareasStore, diasDesde, haceDias, hoyLocal, puedeEliminar, validarLlegada, validarTarea,
} from '../src/tareasService.js';
import { createTareasEvents, createTareasRouter } from '../src/tareasRouter.js';

test('a task needs a title and each slot filled from its own job title', () => {
  const allowed = { licenciado: [1], ingeniero: [2] };
  assert.match(validarTarea({ titulo: '  ' }).error, /título/);
  assert.match(validarTarea({ titulo: 'Oficio', licenciado: '2' }, allowed).error, /licenciado/);
  assert.match(validarTarea({ titulo: 'Oficio', ingeniero: '1' }, allowed).error, /ingeniero/);
  assert.deepEqual(validarTarea({
    titulo: ' Revisar  sábana ', descripcion: ' línea 1\r\nlínea 2 ', licenciado: '1', ingeniero: '2', estado: 'en_proceso', fechaLlegada: '2026-10-01',
  }, allowed).tarea, {
    titulo: 'Revisar sábana', descripcion: 'línea 1\nlínea 2', licenciadoId: 1, ingenieroId: 2, estado: 'en_proceso',
  });
  // Both slots are optional.
  assert.deepEqual(validarTarea({ titulo: 'Sin asignar', licenciado: '', estado: 'otra' }, allowed).tarea,
    { titulo: 'Sin asignar', descripcion: '', licenciadoId: null, ingenieroId: null, estado: 'pendiente' });
});

test('the arrival date is required, real and not in the future, and sets the age frame by whole days', () => {
  const hoy = '2026-10-29';
  assert.match(validarLlegada('', hoy).error, /Escriba/);
  assert.match(validarLlegada('2026-02-30', hoy).error, /no es válida/);
  assert.match(validarLlegada('2026-10-30', hoy).error, /posterior/);
  assert.deepEqual(validarLlegada(' 2026-10-29 ', hoy), { fecha: '2026-10-29' });
  assert.deepEqual(['2026-10-29', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25', '2026-09-30'].map((fecha) => diasDesde(fecha, hoy)),
    [0, 1, 2, 3, 4, 29]);
  assert.deepEqual([0, 1, 2, 3, 4].map(antiguedadOf), ['', '', 'amarilla', 'amarilla', 'roja']);
  assert.deepEqual([0, 1, 5].map(haceDias), ['hoy', 'hace 1 día', 'hace 5 días']);
  // The day turns at midnight in Sonora, not in UTC: 23:30 on the 28th there is already the 29th in UTC.
  assert.equal(hoyLocal(new Date('2026-10-29T06:30:00Z')), '2026-10-28');
});

test('the single responsable of the first version moves to the slot of their job title', async () => {
  const sql = [];
  const pool = {
    query: async (statement) => {
      sql.push(statement.replace(/\s+/g, ' ').trim());
      if (statement.startsWith('SHOW COLUMNS FROM users')) return [[{ Field: 'puesto' }]];
      if (statement.startsWith('SHOW COLUMNS FROM tareas')) return [[{ Field: 'id' }, { Field: 'responsable_id' }]];
      return [[]];
    },
  };
  await createTareasStore(pool).initialize();
  assert.ok(!sql.some((statement) => statement.startsWith('ALTER TABLE users')));
  const migration = sql.filter((statement) => /^(ALTER TABLE tareas|UPDATE tareas)/.test(statement));
  assert.equal(migration.length, 7);
  assert.match(migration[0], /ADD COLUMN licenciado_id/);
  assert.match(migration[1], /ADD COLUMN ingeniero_id/);
  assert.match(migration[2], /SET t.ingeniero_id = IF\(u.puesto = 'ingeniero'/);
  assert.match(migration[3], /DROP COLUMN responsable_id/);
  // Tasks registered before the arrival date existed take the day they were created.
  assert.match(migration[4], /ADD COLUMN fecha_llegada DATE NULL/);
  assert.match(migration[5], /SET fecha_llegada = DATE\(created_at\)/);
  assert.match(migration[6], /MODIFY fecha_llegada DATE NOT NULL/);
});

test('only the creator, an administrator or a semiadministrator may delete a task', () => {
  const tarea = { creadorId: 4 };
  assert.ok(puedeEliminar(tarea, { userId: 4, role: 'usuario' }));
  assert.ok(puedeEliminar(tarea, { userId: 1, role: 'admin', isAdmin: true }));
  assert.ok(puedeEliminar(tarea, { userId: 2, role: 'semiadmin' }));
  assert.ok(!puedeEliminar(tarea, { userId: 5, role: 'usuario' }));
});

test('columns list the oldest arrival first and editing never writes the arrival date', async () => {
  const calls = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT t.id')) {
        return [[{ id: 4, titulo: 'Vieja', estado: 'pendiente', fechaLlegada: '2026-10-20' }, { id: 9, titulo: 'Rara', estado: 'otra', fechaLlegada: null }]];
      }
      return [{ affectedRows: Number(values.at(-1)) === 7 ? 0 : 1, insertId: 12 }];
    },
  };
  const store = createTareasStore(pool);
  const columns = await store.board();
  assert.match(calls.at(-1).sql, /ORDER BY t.fecha_llegada, t.created_at, t.id$/);
  // An unknown column falls back to Pendiente; the date is shown day first.
  assert.deepEqual(columns.pendiente.map((row) => [row.id, row.llegada]), [[4, '20/10/2026'], [9, '']]);

  await store.create({ titulo: 'Nueva', descripcion: '', estado: 'pendiente', licenciadoId: null, ingenieroId: 8, fechaLlegada: '2026-10-28' }, { userId: 5 });
  assert.match(calls.at(-1).sql, /fecha_llegada/);
  assert.deepEqual(calls.at(-1).values.slice(-2), ['2026-10-28', 5]);
  await store.update(4, { titulo: 'Vieja', descripcion: '', estado: 'terminada', licenciadoId: 5, ingenieroId: null, fechaLlegada: '2000-01-01' });
  assert.ok(!calls.at(-1).sql.includes('fecha_llegada') && !calls.at(-1).values.includes('2000-01-01'));
  assert.ok(await store.move(4, 'en_proceso'));
  assert.equal(await store.move(7, 'en_proceso'), false);
  assert.equal(await store.move(4, 'archivada'), false);
});

test('the board is closed to UECS and moves cards by drag or by arrow', async (t) => {
  const tasks = [
    {
      id: 1, titulo: 'Contestar oficio', descripcion: '', estado: 'pendiente', licenciadoId: 5, licenciado: 'ana@udai.mx',
      ingenieroId: 8, ingeniero: 'beto@udai.mx', fechaLlegada: '2026-10-20', llegada: '20/10/2026', dias: 4, creadorId: 5,
    },
    {
      id: 2, titulo: 'Analizar sábana', descripcion: '', estado: 'en_proceso', licenciadoId: null, licenciado: null,
      ingenieroId: null, ingeniero: null, fechaLlegada: '2026-10-27', llegada: '27/10/2026', dias: 2, creadorId: 8,
    },
  ];
  const users = [{ id: 5, email: 'ana@udai.mx', puesto: 'licenciado' }, { id: 8, email: 'beto@udai.mx', puesto: 'ingeniero' }];
  const updated = [];
  const moves = [];
  const created = [];
  const tareas = {
    responsables: async () => users,
    board: async ({ responsable }) => {
      const visible = tasks.filter((task) => !responsable || [task.licenciadoId, task.ingenieroId].map(String).includes(responsable));
      return Object.fromEntries(ESTADOS.map((estado) => [estado, visible.filter((task) => task.estado === estado)]));
    },
    get: async (id) => tasks.find((task) => String(task.id) === String(id)) || null,
    create: async (tarea) => { created.push(tarea); return 3; },
    update: async (id, tarea) => { updated.push([Number(id), tarea]); return true; },
    move: async (id, estado) => {
      moves.push([Number(id), estado]);
      const task = tasks.find((candidate) => String(candidate.id) === String(id));
      if (task) task.estado = estado;
      return Boolean(task);
    },
    remove: async (id, session) => (puedeEliminar(tasks.find((task) => String(task.id) === id), session) ? 'eliminada' : 'sin-permiso'),
  };
  const app = express();
  app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
  app.set('view engine', 'ejs');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-role'];
    req.session = role ? { userId: 5, role } : undefined;
    res.locals.currentUser = req.session ? { id: 5, role } : undefined;
    next();
  });
  let avisos = 0;
  const toasts = [];
  app.use('/tareas', createTareasRouter(null, {
    tareas, eventos: { subscribe: () => {}, notify: () => { avisos += 1; } }, avisar: (userId, toast) => toasts.push([userId, toast]),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/tareas`;
  const as = (role, init = {}) => ({ redirect: 'manual', ...init, headers: { 'x-role': role, ...init.headers } });
  const form = (fields) => ({ method: 'POST', body: new URLSearchParams(fields) });
  const message = (response) => new URL(response.headers.get('location'), base).searchParams.get('message');

  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/');
  assert.equal((await fetch(base, as('uecs'))).headers.get('location'), '/Crud');

  const page = await (await fetch(base, as('usuario'))).text();
  assert.ok(page.includes('Contestar oficio') && page.includes('Analizar sábana'));
  // Four days is red, two is yellow, and each card says how long ago it arrived.
  assert.match(page, /class="tarea-card is-roja" id="tarea-1"/);
  assert.match(page, /class="tarea-card is-amarilla" id="tarea-2"/);
  assert.ok(page.includes('Llegó 20/10/2026') && page.includes('<span class="tarea-dias">hace 4 días</span>'));
  // The new-task form starts on today and cannot pick a later day.
  assert.match(page, new RegExp(`id="fechaLlegada" name="fechaLlegada"[^>]*required max="${hoyLocal()}"[^>]*value="${hoyLocal()}"`));
  // Task 2 was created by someone else, so this user sees no delete button for it.
  assert.ok(page.includes('/tareas/eliminar/1') && !page.includes('/tareas/eliminar/2'));
  assert.ok(page.includes('<span class="tarea-chip-puesto">Lic.</span> ana') && page.includes('<span class="tarea-chip-puesto">Ing.</span> beto'));
  // Each select offers only the people with that job title.
  const select = (html, name) => html.match(new RegExp(`<select id="${name}"[\\s\\S]*?</select>`))[0];
  assert.ok(select(page, 'licenciado').includes('ana@udai.mx') && !select(page, 'licenciado').includes('beto@udai.mx'));
  assert.ok(select(page, 'ingeniero').includes('beto@udai.mx') && !select(page, 'ingeniero').includes('ana@udai.mx'));
  // Filtering by someone finds the tasks where they fill either slot.
  const filtered = await (await fetch(`${base}?responsable=8`, as('usuario'))).text();
  assert.ok(filtered.includes('Contestar oficio') && !filtered.includes('Analizar sábana'));

  const invalid = await fetch(base, as('usuario', form({ titulo: 'Revisar', licenciado: '8', fechaLlegada: '2026-10-01' })));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.text()).includes('Seleccione un licenciado'));
  const noDate = await fetch(base, as('usuario', form({ titulo: 'Revisar', fechaLlegada: '' })));
  assert.equal(noDate.status, 400);
  assert.match(await noDate.text(), /Escriba la fecha de llegada[\s\S]*id="fechaLlegada" name="fechaLlegada" class="form-control is-invalid"/);
  const ok = await fetch(base, as('usuario', form({ titulo: 'Revisar', licenciado: '5', ingeniero: '8', fechaLlegada: '2026-10-01', volver: '5' })));
  assert.match(message(ok), /registrada/);
  assert.match(ok.headers.get('location'), /responsable=5.*#tarea-3$/);
  assert.deepEqual([created[0].licenciadoId, created[0].ingenieroId, created[0].fechaLlegada], [5, 8, '2026-10-01']);
  // The engineer is told; the user who created it filled the licenciado slot themselves, so they are not.
  assert.deepEqual(toasts, [[8, { title: 'Nueva tarea asignada', message: 'Se te asignó “Revisar” como ingeniero.', url: '/tareas#tarea-3' }]]);

  // Ana stops being a licenciada: the task she already has keeps her when it is edited, new tasks no longer offer her.
  users[0].puesto = 'ingeniero';
  const editPage = await (await fetch(`${base}/1/editar`, as('usuario'))).text();
  assert.match(select(editPage, 'licenciado'), /<option value="5" selected>ana@udai.mx/);
  // The arrival date shows read-only, with no field the form would send.
  assert.match(editPage, /id="llegada" class="form-control" readonly[^>]*value="20\/10\/2026 · hace 4 días"/);
  assert.ok(!editPage.includes('name="fechaLlegada"'));
  const edited = form({ titulo: 'Contestar oficio', licenciado: '5', ingeniero: '8', fechaLlegada: '2000-01-01' });
  assert.match(message(await fetch(`${base}/1/editar`, as('usuario', edited))), /actualizada/);
  assert.deepEqual([updated[0][1].licenciadoId, updated[0][1].ingenieroId, updated[0][1].fechaLlegada], [5, 8, undefined]);
  // Saving a task without changing who has it notifies nobody again.
  assert.equal(toasts.length, 1);
  assert.equal((await fetch(base, as('usuario', form({ titulo: 'Otra', licenciado: '5', fechaLlegada: '2026-10-01' })))).status, 400);
  users[0].puesto = 'licenciado';

  const dragged = await fetch(`${base}/2/mover`, as('usuario', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'terminada' }),
  }));
  assert.deepEqual(await dragged.json(), { ok: true });
  const badColumn = await fetch(`${base}/2/mover`, as('usuario', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'archivada' }),
  }));
  assert.equal(badColumn.status, 400);
  assert.match(message(await fetch(`${base}/1/mover`, as('usuario', form({ direccion: 'derecha' })))), /En proceso/);
  assert.match(message(await fetch(`${base}/1/mover`, as('usuario', form({ direccion: 'izquierda' })))), /Pendiente/);
  // There is no column left of the first one.
  const pastEdge = await fetch(`${base}/1/mover`, as('usuario', form({ direccion: 'izquierda', estado: 'terminada' })));
  assert.ok(message(pastEdge).includes('no existe'));
  assert.deepEqual(moves, [[2, 'terminada'], [1, 'en_proceso'], [1, 'pendiente']]);
  // In Terminada and Enviada the frame is dropped by the column's style, so a card dragged there needs no redraw.
  assert.ok(page.includes('.tareas-lista:not([data-estado="terminada"], [data-estado="enviada"]) .tarea-card.is-roja'));

  assert.match(message(await fetch(`${base}/eliminar/2`, as('usuario', form({})))), /Solo quien creó/);
  assert.match(message(await fetch(`${base}/eliminar/1`, as('usuario', form({})))), /eliminada/);
  assert.equal((await fetch(`${base}/eliminar/1`, as('uecs', form({})))).headers.get('location'), '/Crud');
  // Every saved change tells the open boards (create, edit, drag, two arrows, delete); rejected ones do not.
  assert.equal(avisos, 6);

  const columns = await (await fetch(`${base}/tablero?responsable=5`, as('usuario'))).text();
  assert.ok(columns.includes('data-estado="pendiente"') && !columns.includes('<header') && !columns.includes('Nueva tarea'));
  assert.equal((await fetch(`${base}/tablero`, as('uecs'))).headers.get('location'), '/Crud');
});

test('open boards hear about every change until their session expires', async (t) => {
  const eventos = createTareasEvents({ heartbeatMs: 60 * 60 * 1000 });
  const session = { userId: 5, role: 'usuario', lastActivity: Date.now() };
  const app = express();
  app.get('/eventos', (req, res) => { req.session = session; eventos.subscribe(req, res); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/eventos`);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const read = async () => decoder.decode((await reader.read()).value);
  assert.match(await read(), /retry: 5000/);
  assert.equal(eventos.size, 1);
  eventos.notify();
  assert.match(await read(), /event: cambio/);

  session.lastActivity = 0;
  eventos.notify();
  assert.equal((await reader.read()).done, true);
});

test('Falta oficio sits between En proceso and Terminada, and Enviada comes after Terminada', () => {
  assert.deepEqual(ESTADOS.map((estado) => ESTADO_LABELS[estado]), ['Pendiente', 'En proceso', 'Falta oficio', 'Terminada', 'Enviada']);
  assert.ok(ESTADOS.every((estado) => estado.length <= 20));
  assert.equal(validarTarea({ titulo: 'Oficio', estado: 'enviada' }).tarea.estado, 'enviada');
});
