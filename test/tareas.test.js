import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createTareasStore, puedeEliminar, validarTarea } from '../src/tareasService.js';
import { createTareasEvents, createTareasRouter } from '../src/tareasRouter.js';

test('a task needs a title, a real date and each slot filled from its own job title', () => {
  const allowed = { licenciado: [1], ingeniero: [2] };
  assert.match(validarTarea({ titulo: '  ' }).error, /título/);
  assert.match(validarTarea({ titulo: 'Oficio', licenciado: '2' }, allowed).error, /licenciado/);
  assert.match(validarTarea({ titulo: 'Oficio', ingeniero: '1' }, allowed).error, /ingeniero/);
  assert.match(validarTarea({ titulo: 'Oficio', fechaLimite: '2026-02-30' }).error, /fecha/);
  assert.deepEqual(validarTarea({
    titulo: ' Revisar  sábana ', descripcion: ' línea 1\r\nlínea 2 ', licenciado: '1', ingeniero: '2', fechaLimite: '2026-11-03', estado: 'en_proceso',
  }, allowed).tarea, {
    titulo: 'Revisar sábana', descripcion: 'línea 1\nlínea 2', licenciadoId: 1, ingenieroId: 2, fechaLimite: '2026-11-03', estado: 'en_proceso',
  });
  // Both slots are optional.
  assert.deepEqual(validarTarea({ titulo: 'Sin asignar', licenciado: '', estado: 'otra' }, allowed).tarea,
    { titulo: 'Sin asignar', descripcion: '', licenciadoId: null, ingenieroId: null, fechaLimite: null, estado: 'pendiente' });
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
  assert.equal(migration.length, 4);
  assert.match(migration[0], /ADD COLUMN licenciado_id/);
  assert.match(migration[1], /ADD COLUMN ingeniero_id/);
  assert.match(migration[2], /SET t.ingeniero_id = IF\(u.puesto = 'ingeniero'/);
  assert.match(migration[3], /DROP COLUMN responsable_id/);
});

test('only the creator, an administrator or a semiadministrator may delete a task', () => {
  const tarea = { creadorId: 4 };
  assert.ok(puedeEliminar(tarea, { userId: 4, role: 'usuario' }));
  assert.ok(puedeEliminar(tarea, { userId: 1, role: 'admin', isAdmin: true }));
  assert.ok(puedeEliminar(tarea, { userId: 2, role: 'semiadmin' }));
  assert.ok(!puedeEliminar(tarea, { userId: 5, role: 'usuario' }));
});

test('moving a task places it before its new neighbour and renumbers the column', async () => {
  const rows = [
    { id: 1, estado: 'pendiente', posicion: 0 }, { id: 2, estado: 'pendiente', posicion: 1 },
    { id: 3, estado: 'en_proceso', posicion: 0 }, { id: 4, estado: 'en_proceso', posicion: 1 },
  ];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, values) => {
      if (sql.startsWith('SELECT id FROM tareas WHERE id')) return [rows.filter((row) => row.id === Number(values[0]))];
      if (sql.startsWith('SELECT id FROM tareas WHERE estado')) {
        return [rows.filter((row) => row.estado === values[0] && row.id !== Number(values[1])).sort((a, b) => a.posicion - b.posicion)];
      }
      const row = rows.find((candidate) => candidate.id === Number(values[1]));
      if (sql.includes('SET estado')) row.estado = values[0];
      else row.posicion = values[0];
      return [{ affectedRows: 1 }];
    },
  };
  const store = createTareasStore({ query: async () => [[]], getConnection: async () => connection });
  const order = (estado) => rows.filter((row) => row.estado === estado).sort((a, b) => a.posicion - b.posicion).map((row) => row.id);

  assert.ok(await store.move(1, 'en_proceso', 4));
  assert.deepEqual([order('pendiente'), order('en_proceso')], [[2], [3, 1, 4]]);
  // A neighbour that is not in the column, as when the board is filtered, sends the task to the end.
  assert.ok(await store.move(2, 'en_proceso', 99));
  assert.deepEqual(order('en_proceso'), [3, 1, 4, 2]);
  assert.equal(await store.move(7, 'en_proceso', null), false);
  assert.equal(await store.move(1, 'archivada', null), false);
});

test('the board is closed to UECS and moves cards by drag or by arrow', async (t) => {
  const tasks = [
    {
      id: 1, titulo: 'Contestar oficio', descripcion: '', estado: 'pendiente', licenciadoId: 5, licenciado: 'ana@udai.mx',
      ingenieroId: 8, ingeniero: 'beto@udai.mx', fechaLimite: '2020-01-01', creadorId: 5,
    },
    {
      id: 2, titulo: 'Analizar sábana', descripcion: '', estado: 'en_proceso', licenciadoId: null, licenciado: null,
      ingenieroId: null, ingeniero: null, fechaLimite: null, creadorId: 8,
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
      return Object.fromEntries(['pendiente', 'en_proceso', 'terminada'].map((estado) => [estado, visible.filter((task) => task.estado === estado)]));
    },
    get: async (id) => tasks.find((task) => String(task.id) === String(id)) || null,
    create: async (tarea) => { created.push(tarea); return 3; },
    update: async (id, tarea) => { updated.push([Number(id), tarea]); return true; },
    move: async (id, estado, antesDe) => {
      moves.push([Number(id), estado, antesDe]);
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
  app.use('/tareas', createTareasRouter(null, { tareas, eventos: { subscribe: () => {}, notify: () => { avisos += 1; } } }));
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
  assert.ok(page.includes('Contestar oficio') && page.includes('Analizar sábana') && page.includes('vencida'));
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

  const invalid = await fetch(base, as('usuario', form({ titulo: 'Revisar', licenciado: '8' })));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.text()).includes('Seleccione un licenciado'));
  const ok = await fetch(base, as('usuario', form({ titulo: 'Revisar', licenciado: '5', ingeniero: '8', volver: '5' })));
  assert.match(message(ok), /registrada/);
  assert.match(ok.headers.get('location'), /responsable=5.*#tarea-3$/);
  assert.deepEqual([created[0].licenciadoId, created[0].ingenieroId], [5, 8]);

  // Ana stops being a licenciada: the task she already has keeps her when it is edited, new tasks no longer offer her.
  users[0].puesto = 'ingeniero';
  const editPage = await (await fetch(`${base}/1/editar`, as('usuario'))).text();
  assert.match(select(editPage, 'licenciado'), /<option value="5" selected>ana@udai.mx/);
  assert.match(message(await fetch(`${base}/1/editar`, as('usuario', form({ titulo: 'Contestar oficio', licenciado: '5', ingeniero: '8' })))), /actualizada/);
  assert.deepEqual([updated[0][1].licenciadoId, updated[0][1].ingenieroId], [5, 8]);
  assert.equal((await fetch(base, as('usuario', form({ titulo: 'Otra', licenciado: '5' })))).status, 400);
  users[0].puesto = 'licenciado';

  const dragged = await fetch(`${base}/2/mover`, as('usuario', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'terminada', antesDe: 1 }),
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
  assert.deepEqual(moves, [[2, 'terminada', 1], [1, 'en_proceso', null], [1, 'pendiente', null]]);

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
