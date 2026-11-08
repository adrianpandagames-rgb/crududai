import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  ESTADOS, createTareasStore, menciones, puedeEliminar, usuarioDe, validarEtiqueta, validarItem,
} from '../src/tareasService.js';
import { comentarioHtml, createTareasRouter } from '../src/tareasRouter.js';

test('labels, checklist items and @mentions are checked and parsed', () => {
  assert.deepEqual(validarEtiqueta({ nombre: '  Muy   urgente ', color: 'rojo' }), { etiqueta: { nombre: 'Muy urgente', color: 'rojo' } });
  assert.match(validarEtiqueta({ nombre: '', color: 'rojo' }).error, /nombre/);
  assert.match(validarEtiqueta({ nombre: 'x'.repeat(31), color: 'rojo' }).error, /30/);
  assert.match(validarEtiqueta({ nombre: 'Urgente', color: 'fucsia' }).error, /color/);
  assert.deepEqual(validarItem('  Pedir   firma '), { texto: 'Pedir firma' });
  assert.match(validarItem(' ').error, /Escriba/);
  assert.deepEqual(menciones('Hola @Ana.Lopez y @beto. Copia a correo@udai.mx, @ana.lopez otra vez'), ['ana.lopez', 'beto']);
  assert.deepEqual(menciones('sin menciones'), []);
  assert.equal(usuarioDe('Ana.Lopez@udai.mx'), 'ana.lopez');
  // Comments are escaped, and only the mentions become markup.
  assert.equal(comentarioHtml('<b>hola</b> @ana, mail a x@y.mx'), '&lt;b&gt;hola&lt;/b&gt; <span class="tarea-mencion">@ana</span>, mail a x@y.mx');
});

test('the store reads labels and checklist counts with each task and keeps items within their task', async () => {
  const calls = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT t.id')) {
        return [[{ id: 4, titulo: 'T', estado: 'pendiente', fechaLlegada: '2026-11-01', checklistTotal: 3, checklistHechos: '1', etiquetasTexto: '2:rojo:Urgente\n5:azul:Oficio: SAT' }]];
      }
      if (sql.startsWith('SELECT id, texto, hecho')) return [[{ id: 9, texto: 'Firma', hecho: 1 }]];
      if (sql.startsWith('SELECT id FROM tareas_etiquetas')) return [[]];
      return [{ affectedRows: 1, insertId: 7 }];
    },
  };
  const store = createTareasStore(pool);
  const tarea = await store.get(4);
  assert.deepEqual([tarea.checklistTotal, tarea.checklistHechos], [3, 1]);
  assert.deepEqual(tarea.etiquetas, [{ id: 2, color: 'rojo', nombre: 'Urgente' }, { id: 5, color: 'azul', nombre: 'Oficio: SAT' }]);
  assert.ok(!('etiquetasTexto' in tarea));
  assert.deepEqual(await store.item(4, '9'), { id: 9, texto: 'Firma', hecho: true });
  assert.equal(await store.item(4, 10), null);
  await store.marcarItem(4, 9, false);
  assert.match(calls.at(-1).sql, /WHERE id = \? AND tarea_id = \?$/);
  assert.deepEqual(calls.at(-1).values, [0, 9, 4]);
  assert.equal(await store.crearEtiqueta({ nombre: 'Urgente', color: 'rojo' }), 7);
  await store.ponerEtiqueta(4, 7, true);
  assert.match(calls.at(-1).sql, /^INSERT IGNORE INTO tareas_etiquetas_tarea .* SELECT \?, id FROM tareas_etiquetas WHERE id = \?$/);
});

test('the task window posts without leaving the board: checklist, labels, comments with mentions, quick add and delete', async (t) => {
  const tasks = [{
    id: 1, titulo: 'Contestar oficio', descripcion: '', estado: 'pendiente', licenciadoId: 5, licenciado: 'ana@udai.mx',
    ingenieroId: 8, ingeniero: 'beto@udai.mx', fechaLlegada: '2026-10-20', llegada: '20/10/2026', dias: 4, creadorId: 5, etiquetas: [],
  }];
  const users = [{ id: 5, email: 'ana@udai.mx', puesto: 'licenciado' }, { id: 8, email: 'beto@udai.mx', puesto: 'ingeniero' },
    { id: 9, email: 'carla.ruiz@udai.mx', puesto: null }];
  let items = [];
  let etiquetas = [{ id: 3, nombre: 'Urgente', color: 'rojo' }];
  const historia = [];
  const created = [];
  const tareas = {
    responsables: async () => users.filter((user) => user.puesto),
    usuarios: async () => users.map(({ id, email }) => ({ id, email })),
    board: async () => Object.fromEntries(ESTADOS.map((estado) => [estado, tasks.filter((task) => task.estado === estado)])),
    get: async (id) => tasks.find((task) => String(task.id) === String(id)) || null,
    create: async (tarea) => { created.push(tarea); return 2; },
    update: async () => true,
    marcarListo: async (id, puesto, userId, listo) => { tasks[0][`${puesto}Listo`] = listo ? '07/11/2026 10:00' : null; return true; },
    remove: async (id, session) => (puedeEliminar(tasks[0], session) ? 'eliminada' : 'sin-permiso'),
    registrar: async (tareaId, tipo, texto) => { historia.push({ tareaId: Number(tareaId), tipo, texto }); },
    historial: async () => historia.map((entrada) => ({ ...entrada, autor: 'ana@udai.mx', fecha: '07/11/2026 10:00' })),
    etiquetas: async () => etiquetas,
    crearEtiqueta: async ({ nombre, color }) => { etiquetas = [...etiquetas, { id: 4, nombre, color }]; return 4; },
    eliminarEtiqueta: async (id) => { etiquetas = etiquetas.filter((etiqueta) => etiqueta.id !== Number(id)); return true; },
    ponerEtiqueta: async (tareaId, etiquetaId, puesta) => {
      const etiqueta = etiquetas.find((entry) => entry.id === etiquetaId);
      const had = tasks[0].etiquetas.some((entry) => entry.id === etiquetaId);
      if (puesta === had) return false;
      tasks[0].etiquetas = puesta ? [...tasks[0].etiquetas, etiqueta] : tasks[0].etiquetas.filter((entry) => entry.id !== etiquetaId);
      return true;
    },
    checklist: async () => items,
    agregarItem: async (tareaId, texto) => { items = [...items, { id: items.length + 1, texto, hecho: false }]; return items.length; },
    item: async (tareaId, itemId) => items.find((entry) => entry.id === Number(itemId)) || null,
    marcarItem: async (tareaId, itemId, hecho) => { items = items.map((entry) => (entry.id === itemId ? { ...entry, hecho } : entry)); return true; },
    eliminarItem: async (tareaId, itemId) => { items = items.filter((entry) => entry.id !== itemId); return true; },
  };
  const app = express();
  app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
  app.set('view engine', 'ejs');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-role'] || 'usuario';
    req.session = { userId: 5, role, email: 'ana@udai.mx', isAdmin: role === 'admin' };
    res.locals.currentUser = { id: 5, role };
    next();
  });
  const toasts = [];
  let avisos = 0;
  app.use('/tareas', createTareasRouter(null, {
    tareas, eventos: { subscribe: () => {}, notify: () => { avisos += 1; } }, avisar: (userId, toast) => toasts.push([userId, toast]),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/tareas`;
  const modal = { 'X-Tarea-Modal': '1' };
  const post = (path, fields, headers = modal) => fetch(base + path, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams(fields) });

  // The window gets the details alone, without the page around them.
  const detalle = await (await fetch(`${base}/1/editar`, { headers: modal })).text();
  assert.ok(detalle.startsWith('<div class="tarea-detalle"') || detalle.trimStart().startsWith('<div class="tarea-detalle"'));
  assert.ok(!detalle.includes('<html') && detalle.includes('data-cerrar') && !detalle.includes('Volver al tablero'));
  assert.ok(detalle.includes('&#34;h&#34;:&#34;carla.ruiz&#34;') || detalle.includes('&quot;h&quot;:&quot;carla.ruiz&quot;'));
  // The plain page wraps the same details.
  const pagina = await (await fetch(`${base}/1/editar`)).text();
  assert.ok(pagina.includes('<html') && pagina.includes('Volver al tablero') && pagina.includes('class="tarea-detalle"'));

  // Checklist: add, tick, untick, remove; each step answers with the window and leaves a line in the history.
  let html = await (await post('/1/checklist', { texto: ' Pedir firma ' })).text();
  assert.match(html, /tarea-checklist-texto">Pedir firma</);
  assert.ok(html.includes('0/1'));
  html = await (await post('/1/checklist/1', { accion: 'marcar' })).text();
  assert.ok(html.includes('aria-checked="true"') && html.includes('1/1'));
  await post('/1/checklist/1', { accion: 'marcar' });
  await post('/1/checklist/1', { accion: 'desmarcar' });
  assert.equal((await post('/1/checklist', { texto: '  ' })).status, 400);
  assert.equal((await post('/1/checklist/99', { accion: 'marcar' })).status, 404);
  await post('/1/checklist/1', { accion: 'eliminar' });
  assert.deepEqual(items, []);
  assert.deepEqual(historia.map(({ texto }) => texto), [
    'Agregó «Pedir firma» al checklist.', 'Completó «Pedir firma» del checklist.', 'Desmarcó «Pedir firma» del checklist.', 'Quitó «Pedir firma» del checklist.']);
  historia.length = 0;
  // From a plain page, a checklist change returns to the task's page.
  assert.equal((await post('/1/checklist', { texto: 'Otra', volver: '5' }, {})).headers.get('location'), '/tareas/1/editar?volver=5#checklist');
  items = [];
  historia.length = 0;

  // Labels: put one on, create a new one (put straight on), take one off. Only administrators delete labels.
  html = await (await post('/1/etiquetas', { etiqueta: '3', puesta: '1' })).text();
  assert.match(html, /<span class="tarea-etiqueta etiqueta-rojo">Urgente<\/span>/);
  html = await (await post('/1/etiquetas/nueva', { nombre: 'Oficio SAT', color: 'azul' })).text();
  assert.match(html, /etiqueta-azul">Oficio SAT</);
  assert.equal((await post('/1/etiquetas/nueva', { nombre: 'Sin color', color: 'x' })).status, 400);
  await post('/1/etiquetas', { etiqueta: '3', puesta: '0' });
  assert.deepEqual(tasks[0].etiquetas.map(({ nombre }) => nombre), ['Oficio SAT']);
  assert.equal((await post('/1/etiquetas', { etiqueta: '77', puesta: '1' })).status, 400);
  assert.equal((await post('/1/etiquetas/4/eliminar', {})).status, 403);
  assert.ok(!detalle.includes('/etiquetas/3/eliminar'));
  await fetch(`${base}/1/etiquetas/4/eliminar`, { method: 'POST', headers: { ...modal, 'x-role': 'admin' } });
  assert.deepEqual(etiquetas.map(({ id }) => id), [3]);
  assert.deepEqual(historia.map(({ texto }) => texto), ['Agregó la etiqueta Urgente.', 'Agregó la etiqueta Oficio SAT.', 'Quitó la etiqueta Urgente.']);

  // A comment with mentions: the people mentioned are told so, the other assignee hears about the comment,
  // and the author hears about neither, even mentioning themselves.
  toasts.length = 0;
  html = await (await post('/1/comentar', { comentario: '@carla.ruiz revisa esto, @ana' })).text();
  assert.match(html, /<span class="tarea-mencion">@carla\.ruiz<\/span> revisa esto/);
  assert.deepEqual(toasts.map(([userId, toast]) => [userId, toast.title, toast.url]), [
    [9, 'Te mencionaron', '/tareas?tarea=1'], [8, 'Nuevo comentario', '/tareas?tarea=1']]);
  toasts.length = 0;
  await post('/1/comentar', { comentario: 'Listo @beto' });
  assert.deepEqual(toasts.map(([userId, toast]) => [userId, toast.title]), [[8, 'Te mencionaron']]);

  // Saving the form in the window keeps it open with a message; the done mark works the same way.
  assert.match(await (await post('/1/editar', { titulo: 'Contestar oficio', licenciado: '5', ingeniero: '8' })).text(), /Cambios guardados\./);
  assert.match(await (await post('/1/listo', { puesto: 'licenciado', listo: '1' })).text(), /Tu parte quedó marcada como lista\./);
  assert.equal((await post('/1/listo', { puesto: 'ingeniero', listo: '1' })).status, 403);

  // Quick add answers JSON, with the column and arrival date it was given, and reports errors the same way.
  const rapida = await post('/', { titulo: 'Llamar a la compañía', estado: 'en_proceso', fechaLlegada: '2026-11-01' }, { 'X-Tarea-Rapida': '1' });
  assert.equal(rapida.status, 201);
  assert.deepEqual(await rapida.json(), { id: 2 });
  assert.deepEqual([created[0].titulo, created[0].estado, created[0].fechaLlegada], ['Llamar a la compañía', 'en_proceso', '2026-11-01']);
  const sinTitulo = await post('/', { titulo: '', estado: 'pendiente', fechaLlegada: '2026-11-01' }, { 'X-Tarea-Rapida': '1' });
  assert.equal(sinTitulo.status, 400);
  assert.match((await sinTitulo.json()).error, /título/);

  // A notification's link opens the task over the board.
  assert.match(await (await fetch(`${base}?tarea=1`)).text(), /data-abrir="1"/);
  assert.match(await (await fetch(`${base}?tarea=abc`)).text(), /data-abrir=""/);

  // Deleting from the window answers JSON so it can close; not finding the task too.
  assert.deepEqual(await (await post('/eliminar/1', {})).json(), { eliminada: true });
  assert.equal((await fetch(`${base}/99/editar`, { headers: modal })).status, 404);
  assert.ok(avisos > 0);
});
