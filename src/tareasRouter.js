import express from 'express';
import { isSessionExpired } from './sessionUtils.js';
import {
  COLORES_ETIQUETA, ESTADOS, ESTADO_LABELS, MAX_LENGTHS, antiguedadOf, createTareasStore, haceDias, hoyLocal, menciones, puedeBorrarEtiquetas,
  puedeEliminar, usuarioDe, validarComentario, validarEtiqueta, validarItem, validarLlegada, validarTarea,
} from './tareasService.js';
import { puestoLabels, userPuestos } from './usuariosService.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (clave) => {
  const [ano, mes] = clave.split('-').map(Number);
  return MESES[mes - 1] ? `${MESES[mes - 1][0].toUpperCase()}${MESES[mes - 1].slice(1)} ${ano}` : 'Sin fecha de envío';
};

// Proxies close a stream that stays silent; a comment line every 25 s keeps it open.
const HEARTBEAT_MS = 25 * 1000;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
// A comment as HTML, with each @mention highlighted; everything else is escaped.
export const comentarioHtml = (texto) => escapeHtml(texto)
  .replace(/(^|[^\w@.])@([a-z0-9._-]*[a-z0-9])/gi, '$1<span class="tarea-mencion">@$2</span>');

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
// The board opens a task in a window over the columns (public/js/tareas.js). Requests from that window carry the
// X-Tarea-Modal header and get the window's contents back instead of a redirect; without the header every route
// behaves as a plain page, so the board keeps working without JavaScript.
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
        url: `/tareas?tarea=${tareaId}`,
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
  const isId = (value) => /^\d+$/.test(String(value ?? ''));
  const enModal = (req) => req.get('X-Tarea-Modal') === '1';
  const editUrl = (id, filtro, hash = '') => `/tareas/${id}/editar${filtro ? `?volver=${filtro}` : ''}${hash}`;

  // UECS users are kept out of the board, like the metrics.
  router.use((req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    if (req.session.role === 'uecs') return res.status(403).redirect('/Crud');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const boardLocals = async (req, filtro) => ({
    columnas: await tareas.board({ responsable: filtro }), filtro, ESTADOS, ESTADO_LABELS, userPuestos, hoy: hoyLocal(),
    usuarioId: Number(req.session.userId), antiguedadOf, haceDias,
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
  // The names the comment box suggests after "@".
  const mencionables = async () => (await tareas.usuarios()).map(({ email }) => ({ h: usuarioDe(email), e: email }));

  const renderBoard = async (req, res, extra, status = 200) => {
    const filtro = filtroOf(req.query.responsable ?? req.body?.volver);
    const [locals, opciones, etiquetas] = await Promise.all([boardLocals(req, filtro), opcionesOf(), tareas.etiquetas()]);
    // The filter lists everyone who can be assigned, in either slot.
    const responsables = [...opciones.licenciado, ...opciones.ingeniero].sort((a, b) => a.email.localeCompare(b.email));
    return res.status(status).render('pages/tareas', {
      ...locals, opciones, responsables, etiquetas, puestoLabels, form: { fechaLlegada: locals.hoy }, formError: null, message: '', messageType: '',
      abrir: isId(req.query.tarea) ? req.query.tarea : '', ...extra,
    });
  };
  const formOf = (tarea) => ({ ...tarea, licenciado: tarea.licenciadoId ?? '', ingeniero: tarea.ingenieroId ?? '' });
  // A task's details: the edit form, its labels, checklist, history and comment box. The window on the board gets
  // them alone; the edit page wraps them in a page.
  const renderEdit = async (req, res, {
    tarea, opciones, error = null, aviso = null, volver = '', comentario = { texto: '', error: null }, itemError = null, etiquetaError = null,
  }, status = 200) => {
    const [historial, checklist, etiquetas, usuarios] = await Promise.all([
      tareas.historial(tarea.id), tareas.checklist(tarea.id), tareas.etiquetas(), mencionables(),
    ]);
    const modal = enModal(req);
    return res.status(status).render(modal ? 'partials/tarea-detalle' : 'pages/editar-tarea', {
      tarea, opciones, puestoLabels, haceDias, ESTADOS, ESTADO_LABELS, error, aviso, volver, modal,
      historial, comentario, maxComentario: MAX_LENGTHS.comentario, maxItem: MAX_LENGTHS.checklist, maxEtiqueta: MAX_LENGTHS.etiqueta,
      checklist, etiquetas, itemError, etiquetaError, colores: COLORES_ETIQUETA, usuarios, comentarioHtml,
      usuarioId: Number(req.session.userId), puedeEliminar: puedeEliminar(tarea, req.session), puedeBorrarEtiquetas: puedeBorrarEtiquetas(req.session),
    });
  };
  // The task as saved now, shown in the window with a message; or, from a plain page, back to its edit page.
  const mostrar = async (req, res, id, extra = {}, status = 200, hash = '') => {
    const filtro = filtroOf(req.body?.volver ?? req.query.volver);
    if (!enModal(req) && status < 400) return res.redirect(303, editUrl(id, filtro, hash));
    const tarea = await tareas.get(id);
    if (!tarea) return enModal(req) ? res.status(404).json({ error: 'La tarea no fue encontrada.' }) : redirect(res, 'La tarea no fue encontrada.', 'error', { filtro });
    return renderEdit(req, res, { tarea: formOf(tarea), opciones: await opcionesOf(tarea), volver: filtro, ...extra }, status);
  };
  const noEncontrada = (req, res) => (enModal(req)
    ? res.status(404).json({ error: 'La tarea no fue encontrada.' })
    : redirect(res, 'La tarea no fue encontrada.', 'error', { filtro: filtroOf(req.body?.volver) }));

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

  // The full form and the quick "Añadir tarjeta" at the foot of a column both post here. The quick one, sent by
  // script with X-Tarea-Rapida, gets JSON so the column stays open for the next card.
  router.post('/', async (req, res, next) => {
    const rapida = req.get('X-Tarea-Rapida') === '1';
    try {
      const { tarea, error, field } = validarTarea(req.body, allowedOf(await opcionesOf()));
      const llegada = validarLlegada(req.body.fechaLlegada);
      const failure = error ? { message: error, field } : llegada.error ? { message: llegada.error, field: 'fechaLlegada' } : null;
      if (failure) return rapida ? res.status(400).json({ error: failure.message }) : await renderBoard(req, res, { form: req.body, formError: failure }, 400);
      const tareaId = await tareas.create({ ...tarea, fechaLlegada: llegada.fecha }, req.session);
      await registrarCambio(req, [`creó la tarea en ${ESTADO_LABELS[tarea.estado]}`], tareaId);
      eventos.notify();
      avisarAsignados(tareaId, tarea, req.session);
      if (rapida) return res.status(201).json({ id: Number(tareaId) });
      return redirect(res, 'Tarea registrada correctamente.', 'success', { filtro: filtroOf(req.body.volver), tareaId });
    } catch (failure) {
      return next(failure);
    }
  });

  router.get('/:id/editar', async (req, res, next) => {
    try {
      const tarea = isId(req.params.id) ? await tareas.get(req.params.id) : null;
      if (!tarea) return noEncontrada(req, res);
      return await renderEdit(req, res, { tarea: formOf(tarea), opciones: await opcionesOf(tarea), volver: filtroOf(req.query.volver) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/editar', async (req, res, next) => {
    if (!isId(req.params.id)) return noEncontrada(req, res);
    const filtro = filtroOf(req.body.volver);
    try {
      const actual = await tareas.get(req.params.id);
      if (!actual) return noEncontrada(req, res);
      const opciones = await opcionesOf(actual);
      const { tarea, error } = validarTarea(req.body, allowedOf(opciones));
      // What was typed, over the saved task so the arrival date and creator still show.
      if (error) return await renderEdit(req, res, { tarea: { ...actual, ...req.body, id: actual.id }, opciones, error, volver: filtro }, 400);
      // Someone saved the task after this form was opened: the form comes back with what was typed, told who changed it,
      // and with the new version, so saving again replaces their change on purpose. Forms opened before versions existed send none.
      const version = typeof req.body.version === 'string' ? req.body.version : '';
      const conflicto = async (vigente) => {
        const ultimo = (await tareas.historial(vigente.id)).filter((entrada) => entrada.tipo === 'cambio').at(-1);
        const quien = ultimo ? `${ultimo.autor || 'Otra persona'} la modificó el ${ultimo.fecha}: ${ultimo.texto}` : 'Alguien más la modificó.';
        return renderEdit(req, res, {
          tarea: { ...vigente, ...req.body, id: vigente.id, version: vigente.version }, opciones: await opcionesOf(vigente), volver: filtro,
          error: `Esta tarea cambió mientras la editabas. ${quien} Revisa los datos; si guardas de nuevo, se guardará lo que tienes en el formulario.`,
        }, 409);
      };
      if (version && version !== actual.version) return await conflicto(actual);
      const updated = await tareas.update(req.params.id, tarea, version);
      if (!updated && version) {
        const vigente = await tareas.get(req.params.id);
        if (vigente) return await conflicto(vigente);
      }
      if (!updated) return noEncontrada(req, res);
      await registrarCambio(req, cambiosDe(actual, tarea, opciones));
      eventos.notify();
      avisarAsignados(req.params.id, tarea, req.session, actual);
      if (enModal(req)) return await mostrar(req, res, req.params.id, { aviso: 'Cambios guardados.' });
      return redirect(res, 'Tarea actualizada correctamente.', 'success', { filtro, tareaId: req.params.id });
    } catch (failure) {
      return next(failure);
    }
  });

  // Anyone who can open the board may comment on a task. Whoever is @mentioned is told so; the people assigned
  // to it hear about the comment otherwise. The author is never told about their own comment.
  router.post('/:id/comentar', async (req, res, next) => {
    const filtro = filtroOf(req.body.volver);
    if (!isId(req.params.id)) return noEncontrada(req, res);
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return noEncontrada(req, res);
      const { texto, error } = validarComentario(req.body.comentario);
      if (error) {
        return await renderEdit(req, res, {
          tarea: formOf(tarea), opciones: await opcionesOf(tarea), volver: filtro, comentario: { texto: req.body.comentario ?? '', error },
        }, 400);
      }
      const userId = Number(req.session.userId);
      await tareas.registrar(tarea.id, 'comentario', texto, userId);
      eventos.notify();
      const autor = req.session.email || 'Alguien';
      const resumen = texto.length > 120 ? `${texto.slice(0, 120)}…` : texto;
      const url = `/tareas?tarea=${tarea.id}`;
      const nombres = menciones(texto);
      const mencionados = new Set(nombres.length
        ? (await tareas.usuarios()).filter(({ email }) => nombres.includes(usuarioDe(email))).map(({ id }) => id).filter((id) => id !== userId)
        : []);
      mencionados.forEach((id) => avisar(id, { title: 'Te mencionaron', message: `${autor} te mencionó en “${tarea.titulo}”: ${resumen}`, url }));
      new Set(userPuestos.map((puesto) => tarea[`${puesto}Id`]).filter((id) => id != null && id !== userId && !mencionados.has(id)))
        .forEach((id) => avisar(id, { title: 'Nuevo comentario', message: `${autor} comentó en “${tarea.titulo}”: ${resumen}`, url }));
      return await mostrar(req, res, tarea.id, {}, 200, '#historial');
    } catch (failure) {
      return next(failure);
    }
  });

  // ---- Checklist ----
  router.post('/:id/checklist', async (req, res, next) => {
    if (!isId(req.params.id)) return noEncontrada(req, res);
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return noEncontrada(req, res);
      const { texto, error } = validarItem(req.body.texto);
      if (error) return await mostrar(req, res, tarea.id, { itemError: error }, 400);
      await tareas.agregarItem(tarea.id, texto);
      await registrarCambio(req, [`agregó «${texto}» al checklist`]);
      eventos.notify();
      return await mostrar(req, res, tarea.id, {}, 200, '#checklist');
    } catch (failure) {
      return next(failure);
    }
  });

  // accion is "marcar", "desmarcar" or "eliminar".
  router.post('/:id/checklist/:itemId', async (req, res, next) => {
    if (!isId(req.params.id) || !isId(req.params.itemId)) return noEncontrada(req, res);
    try {
      const entry = await tareas.item(req.params.id, req.params.itemId);
      if (!entry) return noEncontrada(req, res);
      const { accion } = req.body;
      if (accion === 'eliminar') {
        await tareas.eliminarItem(req.params.id, entry.id);
        await registrarCambio(req, [`quitó «${entry.texto}» del checklist`]);
      } else if (accion === 'marcar' || accion === 'desmarcar') {
        const hecho = accion === 'marcar';
        if (hecho !== entry.hecho) {
          await tareas.marcarItem(req.params.id, entry.id, hecho);
          await registrarCambio(req, [`${hecho ? 'completó' : 'desmarcó'} «${entry.texto}» del checklist`]);
        }
      } else {
        return await mostrar(req, res, req.params.id, { itemError: 'Acción no válida.' }, 400);
      }
      eventos.notify();
      return await mostrar(req, res, req.params.id, {}, 200, '#checklist');
    } catch (failure) {
      return next(failure);
    }
  });

  // ---- Labels ----
  // Puts a label on the task or takes it off (puesta = 1 or 0).
  router.post('/:id/etiquetas', async (req, res, next) => {
    if (!isId(req.params.id) || !isId(req.body.etiqueta)) return noEncontrada(req, res);
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return noEncontrada(req, res);
      const etiqueta = (await tareas.etiquetas()).find((entry) => entry.id === Number(req.body.etiqueta));
      if (!etiqueta) return await mostrar(req, res, tarea.id, { etiquetaError: 'La etiqueta ya no existe.' }, 400);
      const puesta = req.body.puesta === '1';
      if (await tareas.ponerEtiqueta(tarea.id, etiqueta.id, puesta)) {
        await registrarCambio(req, [`${puesta ? 'agregó' : 'quitó'} la etiqueta ${etiqueta.nombre}`]);
        eventos.notify();
      }
      return await mostrar(req, res, tarea.id, {}, 200, '#etiquetas');
    } catch (failure) {
      return next(failure);
    }
  });

  // A new label, put straight on the task it was created from.
  router.post('/:id/etiquetas/nueva', async (req, res, next) => {
    if (!isId(req.params.id)) return noEncontrada(req, res);
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return noEncontrada(req, res);
      const { etiqueta, error } = validarEtiqueta(req.body);
      if (error) return await mostrar(req, res, tarea.id, { etiquetaError: error }, 400);
      const etiquetaId = await tareas.crearEtiqueta(etiqueta);
      if (await tareas.ponerEtiqueta(tarea.id, etiquetaId, true)) await registrarCambio(req, [`agregó la etiqueta ${etiqueta.nombre}`]);
      eventos.notify();
      return await mostrar(req, res, tarea.id, {}, 200, '#etiquetas');
    } catch (failure) {
      return next(failure);
    }
  });

  // Deleting a label takes it off every task; only administrators and semiadministrators may.
  router.post('/:id/etiquetas/:etiquetaId/eliminar', async (req, res, next) => {
    if (!isId(req.params.id) || !isId(req.params.etiquetaId)) return noEncontrada(req, res);
    try {
      if (!puedeBorrarEtiquetas(req.session)) {
        return await mostrar(req, res, req.params.id, { etiquetaError: 'Solo un administrador puede eliminar etiquetas.' }, 403);
      }
      await tareas.eliminarEtiqueta(req.params.etiquetaId);
      eventos.notify();
      return await mostrar(req, res, req.params.id, {}, 200, '#etiquetas');
    } catch (failure) {
      return next(failure);
    }
  });

  // Dragging a card sends JSON with the new column; a form may send direccion, which moves the task one column
  // left or right. Either way the task takes its place in the new column by arrival date.
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
    if (!isId(req.params.id) || !userPuestos.includes(puesto)) return noEncontrada(req, res);
    try {
      const tarea = await tareas.get(req.params.id);
      if (!tarea) return noEncontrada(req, res);
      const userId = Number(req.session.userId);
      if (tarea[`${puesto}Id`] !== userId) {
        const message = `Solo el ${puestoLabels[puesto].toLowerCase()} asignado puede marcar su parte como lista.`;
        return enModal(req) ? await mostrar(req, res, tarea.id, { error: message }, 403) : redirect(res, message, 'error', { filtro, tareaId: tarea.id });
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
          url: `/tareas?tarea=${tarea.id}`,
        }));
      }
      const message = listo ? 'Tu parte quedó marcada como lista.' : 'Tu parte quedó como pendiente.';
      if (enModal(req)) return await mostrar(req, res, tarea.id, { aviso: message });
      return redirect(res, message, 'success', { filtro, tareaId: tarea.id });
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
        return enModal(req) ? res.json({ eliminada: true }) : redirect(res, 'Tarea eliminada correctamente.', 'success', { filtro });
      }
      const message = outcome === 'sin-permiso' ? 'Solo quien creó la tarea o un administrador puede eliminarla.' : 'La tarea no fue encontrada.';
      if (enModal(req)) return res.status(outcome === 'sin-permiso' ? 403 : 404).json({ error: message });
      return redirect(res, message, 'error', { filtro, ...(outcome === 'sin-permiso' ? { tareaId: req.params.id } : {}) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
