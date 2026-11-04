import express from 'express';
import { isSessionExpired } from './sessionUtils.js';
import {
  ESTADOS, ESTADO_LABELS, MAX_LENGTHS, antiguedadOf, createTareasStore, haceDias, hoyLocal, puedeEliminar, validarComentario, validarLlegada,
  validarTarea,
} from './tareasService.js';
import { puestoLabels, userPuestos } from './usuariosService.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (clave) => {
  const [ano, mes] = clave.split('-').map(Number);
  return MESES[mes - 1] ? `${MESES[mes - 1][0].toUpperCase()}${MESES[mes - 1].slice(1)} ${ano}` : 'Sin fecha de envío';
};

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

// `avisar(userId, toast)` queues the toast every page polls for. Whoever takes a slot is told, unless they filled it themselves.
export function createTareasRouter(pool, {
  tareas = createTareasStore(pool), eventos = createTareasEvents(), avisar = () => {},
} = {}) {
  const router = express.Router();
  const avisarAsignados = (tareaId, tarea, session, anterior = {}) => {
    for (const puesto of userPuestos) {
      const userId = tarea[`${puesto}Id`];
      if (userId == null || userId === anterior[`${puesto}Id`] || userId === session?.userId) continue;
      avisar(userId, {
        title: 'Nueva tarea asignada',
        message: `Se te asignó “${tarea.titulo}” como ${puestoLabels[puesto].toLowerCase()}.`,
        url: `/tareas#tarea-${tareaId}`,
      });
    }
  };
  // Every change to a task leaves one line in its history, made of the clauses given, e.g. "Movió la tarea de
  // Pendiente a En proceso." Nothing is written when nothing changed.
  const registrarCambio = async (req, cambios, tareaId = req.params.id) => {
    if (!cambios.length) return;
    const texto = cambios.join('; ');
    await tareas.registrar(tareaId, 'cambio', `${texto[0].toUpperCase()}${texto.slice(1)}.`, req.session.userId);
  };
  const movida = (antes, despues) => `movió la tarea de ${ESTADO_LABELS[antes] ?? antes} a ${ESTADO_LABELS[despues]}`;
  // What an edit changed, compared with the task as it was saved; opciones names the people in each slot.
  const cambiosDe = (antes, despues, opciones) => {
    const cambios = [];
    if (antes.titulo !== despues.titulo) cambios.push(`cambió el título de “${antes.titulo}” a “${despues.titulo}”`);
    if ((antes.descripcion || '') !== despues.descripcion) cambios.push('cambió la descripción');
    for (const puesto of userPuestos) {
      const [previo, nuevo] = [antes[`${puesto}Id`], despues[`${puesto}Id`]];
      if (previo === nuevo) continue;
      const nombre = (id) => opciones[puesto].find((user) => user.id === id)?.email || `Usuario ${id}`;
      const puestoTexto = puestoLabels[puesto].toLowerCase();
      if (previo == null) cambios.push(`asignó a ${nombre(nuevo)} como ${puestoTexto}`);
      else if (nuevo == null) cambios.push(`quitó a ${nombre(previo)} como ${puestoTexto}`);
      else cambios.push(`cambió el ${puestoTexto} de ${nombre(previo)} a ${nombre(nuevo)}`);
    }
    if (antes.estado !== despues.estado) cambios.push(movida(antes.estado, despues.estado));
    return cambios;
  };

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
    columnas: await tareas.board({ responsable: filtro }), filtro, ESTADOS, ESTADO_LABELS, userPuestos,
    usuarioId: Number(req.session.userId),
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
  // The edit page also shows the task's history, with the form to comment on it.
  const renderEdit = async (res, {
    tarea, opciones, error = null, volver = '', comentario = { texto: '', error: null },
  }, status = 200) => res.status(status).render('pages/editar-tarea', {
    tarea, opciones, puestoLabels, haceDias, ESTADOS, ESTADO_LABELS, error, volver,
    historial: await tareas.historial(tarea.id), comentario, maxComentario: MAX_LENGTHS.comentario,
  });

  router.get('/eventos', (req, res) => eventos.subscribe(req, res));

  // Tasks that were already in Enviada before this month, out of the board but still searchable.
  router.get('/archivo', async (req, res, next) => {
    try {
      const buscar = typeof req.query.buscar === 'string' ? req.query.buscar.trim().slice(0, 200) : '';
      const lista = await tareas.archivo({ buscar });
      // Grouped by the month they were sent, latest first, as the list already comes.
      const meses = [];
      lista.forEach((tarea) => {
        const clave = (tarea.enviadaEl || '').slice(0, 7);
        if (meses.at(-1)?.clave !== clave) meses.push({ clave, nombre: nombreMes(clave), tareas: [] });
        meses.at(-1).tareas.push(tarea);
      });
      return res.render('pages/tareas-archivo', { meses, total: lista.length, buscar });
    } catch (error) {
      return next(error);
    }
  });

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
      await registrarCambio(req, [`creó la tarea en ${ESTADO_LABELS[tarea.estado]}`], tareaId);
      eventos.notify();
      avisarAsignados(tareaId, tarea, req.session);
      return redirect(res, 'Tarea registrada correctamente.', 'success', { filtro: filtroOf(req.body.volver), tareaId });
    } catch (failure) {
      return next(failure);
    }
  });

  router.get('/:id/editar', async (req, res, next) => {
    try {
      const tarea = isId(req.params.id) ? await tareas.get(req.params.id) : null;
      if (!tarea) return redirect(res, 'La tarea no fue encontrada.');
      return await renderEdit(res, {
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
      if (error) return await renderEdit(res, { tarea: { ...actual, ...req.body, id: req.params.id }, opciones, error, volver: filtro }, 400);
      // Someone saved the task after this form was opened: the form comes back with what was typed, told who changed it,
      // and with the new version, so saving again replaces their change on purpose. Forms opened before versions existed send none.
      const version = typeof req.body.version === 'string' ? req.body.version : '';
      const conflicto = async (vigente) => {
        const ultimo = (await tareas.historial(vigente.id)).filter((entrada) => entrada.tipo === 'cambio').at(-1);
        const quien = ultimo ? `${ultimo.autor || 'Otra persona'} la modificó el ${ultimo.fecha}: ${ultimo.texto}` : 'Alguien más la modificó.';
        return renderEdit(res, {
          tarea: { ...vigente, ...req.body, id: req.params.id, version: vigente.version }, opciones: await opcionesOf(vigente), volver: filtro,
          error: `Esta tarea cambió mientras la editabas. ${quien} Revisa los datos; si guardas de nuevo, se guardará lo que tienes en el formulario.`,
        }, 409);
      };
      if (version && version !== actual.version) return await conflicto(actual);
      const updated = await tareas.update(req.params.id, tarea, version);
      if (!updated && version) {
        const vigente = await tareas.get(req.params.id);
        if (vigente) return await conflicto(vigente);
      }
      if (updated) {
        await registrarCambio(req, cambiosDe(actual, tarea, opciones));
        eventos.notify();
        avisarAsignados(req.params.id, tarea, req.session, actual);
      }
      return updated ? redirect(res, 'Tarea actualizada correctamente.', 'success', { filtro, tareaId: req.params.id })
        : redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
    } catch (failure) {
      return next(failure);
    }
  });

  // Anyone who can open the board may comment on a task; the people assigned to it are told, except the author.
  router.post('/:id/comentar', async (req, res, next) => {
    const filtro = filtroOf(req.body.volver);
    if (!isId(req.params.id)) return redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
      const { texto, error } = validarComentario(req.body.comentario);
      if (error) {
        return await renderEdit(res, {
          tarea: { ...tarea, licenciado: tarea.licenciadoId ?? '', ingeniero: tarea.ingenieroId ?? '' },
          opciones: await opcionesOf(tarea), volver: filtro, comentario: { texto: req.body.comentario ?? '', error },
        }, 400);
      }
      const userId = Number(req.session.userId);
      await tareas.registrar(tarea.id, 'comentario', texto, userId);
      eventos.notify();
      const autor = req.session.email || 'Alguien';
      new Set(userPuestos.map((puesto) => tarea[`${puesto}Id`]).filter((id) => id != null && id !== userId)).forEach((id) => avisar(id, {
        title: 'Nuevo comentario',
        message: `${autor} comentó en “${tarea.titulo}”: ${texto.length > 120 ? `${texto.slice(0, 120)}…` : texto}`,
        url: `/tareas/${tarea.id}/editar#historial`,
      }));
      return res.redirect(`/tareas/${tarea.id}/editar${filtro ? `?volver=${filtro}` : ''}#historial`);
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
      const desde = (await tareas.get(req.params.id))?.estado;
      if (!desde) return fail(404, 'La tarea no fue encontrada.');
      if (!json) {
        const step = req.body.direccion === 'izquierda' ? -1 : req.body.direccion === 'derecha' ? 1 : 0;
        estado = ESTADOS[ESTADOS.indexOf(desde) + step];
      }
      if (!ESTADOS.includes(estado)) return fail(400, 'La columna indicada no existe.');
      const moved = await tareas.move(req.params.id, estado);
      if (!moved) return fail(404, 'La tarea no fue encontrada.');
      if (estado !== desde) await registrarCambio(req, [movida(desde, estado)]);
      eventos.notify();
      return json ? res.json({ ok: true })
        : redirect(res, `Tarea movida a ${ESTADO_LABELS[estado]}.`, 'success', { filtro: filtroOf(req.body.volver), tareaId: req.params.id });
    } catch (error) {
      return next(error);
    }
  });

  // Whoever fills a slot marks their own part as done, or takes the mark back. The other assignee is told when
  // a part is done.
  router.post('/:id/listo', async (req, res, next) => {
    const filtro = filtroOf(req.body.volver);
    const { puesto } = req.body;
    if (!isId(req.params.id) || !userPuestos.includes(puesto)) return redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
      const userId = Number(req.session.userId);
      if (tarea[`${puesto}Id`] !== userId) {
        return redirect(res, `Solo el ${puestoLabels[puesto].toLowerCase()} asignado puede marcar su parte como lista.`, 'error', { filtro, tareaId: tarea.id });
      }
      const listo = req.body.listo === '1';
      await tareas.marcarListo(tarea.id, puesto, userId, listo);
      await registrarCambio(req, [`${listo ? 'marcó' : 'desmarcó'} su parte de ${puestoLabels[puesto].toLowerCase()} como lista`]);
      eventos.notify();
      if (listo) {
        const avisados = new Set(userPuestos.map((otro) => tarea[`${otro}Id`]).filter((id) => id != null && id !== userId));
        avisados.forEach((id) => avisar(id, {
          title: 'Parte de tarea lista',
          message: `${tarea[puesto]} terminó su parte de “${tarea.titulo}” como ${puestoLabels[puesto].toLowerCase()}.`,
          url: `/tareas#tarea-${tarea.id}`,
        }));
      }
      return redirect(res, listo ? 'Tu parte quedó marcada como lista.' : 'Tu parte quedó como pendiente.', 'success', { filtro, tareaId: tarea.id });
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
