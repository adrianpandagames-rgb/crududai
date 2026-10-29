import express from 'express';
import { isSessionExpired } from './sessionUtils.js';
import {
  ESTADOS, ESTADO_LABELS, antiguedadOf, createTareasStore, haceDias, hoyLocal, puedeEliminar, validarLlegada, validarTarea,
} from './tareasService.js';
import { puestoLabels, userPuestos } from './usuariosService.js';

// Proxies close a stream that stays silent; a comment line every 25 s keeps it open.
const HEARTBEAT_MS = 25 * 1000;

// Open boards listen on /tareas/eventos (Server-Sent Events) and reload their columns when a task changes.
// The listeners live in this process, which works because PM2 runs a single instance, as the in-memory sessions already require.
export function createTareasEvents({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set();
  const send = (client, chunk) => {
    if (isSessionExpired(client.session)) {
      client.res.end();
      return;
    }
    client.res.write(chunk);
  };
  const timer = setInterval(() => clients.forEach((client) => send(client, ': latido\n\n')), heartbeatMs);
  timer.unref();
  return {
    subscribe(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Stops nginx from buffering the stream.
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      const client = { res, session: req.session };
      clients.add(client);
      req.on('close', () => clients.delete(client));
    },
    notify() {
      clients.forEach((client) => send(client, 'event: cambio\ndata: {}\n\n'));
    },
    get size() { return clients.size; },
  };
}

export function createTareasRouter(pool, { tareas = createTareasStore(pool), eventos = createTareasEvents() } = {}) {
  const router = express.Router();
  // Forms send the board's filter back in a hidden "volver" field, so an action returns to the same view.
  const filtroOf = (value) => (typeof value === 'string' && /^(\d+|sin)$/.test(value) ? value : '');
  const redirect = (res, message, type = 'error', { filtro = '', tareaId } = {}) => res.redirect('/tareas?' + new URLSearchParams({
    ...(filtro ? { responsable: filtro } : {}), message, type,
  }) + (tareaId ? `#tarea-${tareaId}` : ''));
  const isId = (value) => /^\d+$/.test(value);

  // UECS users are kept out of the board, like the metrics.
  router.use((req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    if (req.session.role === 'uecs') return res.status(403).redirect('/Crud');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const boardLocals = async (req, filtro) => ({
    columnas: await tareas.board({ responsable: filtro }), filtro, ESTADOS, ESTADO_LABELS,
    puedeEliminar: (tarea) => puedeEliminar(tarea, req.session), antiguedadOf, haceDias,
  });

  // The people each slot offers: users with that job title, plus whoever already fills it on the task being edited,
  // so that changing someone's job title later does not clear them from their tasks when the task is saved.
  const opcionesOf = async (actual = null) => {
    const users = await tareas.responsables();
    return Object.fromEntries(userPuestos.map((puesto) => {
      const list = users.filter((user) => user.puesto === puesto);
      const currentId = actual?.[`${puesto}Id`];
      if (currentId != null && !list.some((user) => user.id === currentId)) list.push({ id: currentId, email: actual[puesto] || `Usuario ${currentId}` });
      return [puesto, list];
    }));
  };
  const allowedOf = (opciones) => Object.fromEntries(Object.entries(opciones).map(([puesto, list]) => [puesto, list.map((user) => user.id)]));

  const renderBoard = async (req, res, extra, status = 200) => {
    const filtro = filtroOf(req.query.responsable ?? req.body?.volver);
    const [locals, opciones] = await Promise.all([boardLocals(req, filtro), opcionesOf()]);
    // The filter lists everyone who can be assigned, in either slot.
    const responsables = [...opciones.licenciado, ...opciones.ingeniero].sort((a, b) => a.email.localeCompare(b.email));
    const hoy = hoyLocal();
    return res.status(status).render('pages/tareas', {
      ...locals, opciones, responsables, puestoLabels, hoy, form: { fechaLlegada: hoy }, formError: null, message: '', messageType: '', ...extra,
    });
  };
  const renderEdit = (res, { tarea, opciones, error = null, volver = '' }, status = 200) => res.status(status).render('pages/editar-tarea', {
    tarea, opciones, puestoLabels, haceDias, ESTADOS, ESTADO_LABELS, error, volver,
  });

  router.get('/eventos', (req, res) => eventos.subscribe(req, res));

  // Only the columns, which open boards fetch when told that a task changed.
  router.get('/tablero', async (req, res, next) => {
    try {
      res.render('partials/tareas-tablero', await boardLocals(req, filtroOf(req.query.responsable)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      await renderBoard(req, res, {
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { tarea, error, field } = validarTarea(req.body, allowedOf(await opcionesOf()));
      const llegada = validarLlegada(req.body.fechaLlegada);
      const failure = error ? { message: error, field } : llegada.error ? { message: llegada.error, field: 'fechaLlegada' } : null;
      if (failure) return await renderBoard(req, res, { form: req.body, formError: failure }, 400);
      const tareaId = await tareas.create({ ...tarea, fechaLlegada: llegada.fecha }, req.session);
      eventos.notify();
      return redirect(res, 'Tarea registrada correctamente.', 'success', { filtro: filtroOf(req.body.volver), tareaId });
    } catch (failure) {
      return next(failure);
    }
  });

  router.get('/:id/editar', async (req, res, next) => {
    try {
      const tarea = isId(req.params.id) ? await tareas.get(req.params.id) : null;
      if (!tarea) return redirect(res, 'La tarea no fue encontrada.');
      return renderEdit(res, {
        tarea: { ...tarea, licenciado: tarea.licenciadoId ?? '', ingeniero: tarea.ingenieroId ?? '' },
        opciones: await opcionesOf(tarea), volver: filtroOf(req.query.volver),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/editar', async (req, res, next) => {
    if (!isId(req.params.id)) return redirect(res, 'La tarea no fue encontrada.');
    const filtro = filtroOf(req.body.volver);
    try {
      const actual = await tareas.get(req.params.id);
      if (!actual) return redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
      const opciones = await opcionesOf(actual);
      const { tarea, error } = validarTarea(req.body, allowedOf(opciones));
      // What was typed, over the saved task so the arrival date and creator still show.
      if (error) return renderEdit(res, { tarea: { ...actual, ...req.body, id: req.params.id }, opciones, error, volver: filtro }, 400);
      const updated = await tareas.update(req.params.id, tarea);
      if (updated) eventos.notify();
      return updated ? redirect(res, 'Tarea actualizada correctamente.', 'success', { filtro, tareaId: req.params.id })
        : redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
    } catch (failure) {
      return next(failure);
    }
  });

  // Dragging a card sends JSON with the new column; the arrow buttons send a form with direccion, which moves the
  // task one column left or right. Either way the task takes its place in the new column by arrival date.
  router.post('/:id/mover', async (req, res, next) => {
    const json = req.is('application/json');
    const fail = (status, message) => (json ? res.status(status).json({ error: message }) : redirect(res, message, 'error', { filtro: filtroOf(req.body.volver) }));
    if (!isId(req.params.id)) return fail(404, 'La tarea no fue encontrada.');
    try {
      let { estado } = req.body;
      if (!json) {
        const current = await tareas.get(req.params.id);
        if (!current) return fail(404, 'La tarea no fue encontrada.');
        const step = req.body.direccion === 'izquierda' ? -1 : req.body.direccion === 'derecha' ? 1 : 0;
        estado = ESTADOS[ESTADOS.indexOf(current.estado) + step];
      }
      if (!ESTADOS.includes(estado)) return fail(400, 'La columna indicada no existe.');
      const moved = await tareas.move(req.params.id, estado);
      if (!moved) return fail(404, 'La tarea no fue encontrada.');
      eventos.notify();
      return json ? res.json({ ok: true })
        : redirect(res, `Tarea movida a ${ESTADO_LABELS[estado]}.`, 'success', { filtro: filtroOf(req.body.volver), tareaId: req.params.id });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/eliminar/:id', async (req, res, next) => {
    const filtro = filtroOf(req.body.volver);
    try {
      const outcome = isId(req.params.id) ? await tareas.remove(req.params.id, req.session) : 'no-encontrada';
      if (outcome === 'eliminada') {
        eventos.notify();
        return redirect(res, 'Tarea eliminada correctamente.', 'success', { filtro });
      }
      return outcome === 'sin-permiso'
        ? redirect(res, 'Solo quien creó la tarea o un administrador puede eliminarla.', 'error', { filtro, tareaId: req.params.id })
        : redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
