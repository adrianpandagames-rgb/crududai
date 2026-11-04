import { ensureUserPuesto, puestoLabels, userPuestos } from './usuariosService.js';

// The board's columns, left to right.
export const ESTADOS = ['pendiente', 'en_proceso', 'falta_oficio', 'terminada', 'enviada'];
export const ESTADO_LABELS = {
  pendiente: 'Pendiente', en_proceso: 'En proceso', falta_oficio: 'Falta oficio', terminada: 'Terminada', enviada: 'Enviada',
};
export const MAX_LENGTHS = { titulo: 200, descripcion: 2000, comentario: 1000 };

// Whole days since a task arrived before its card is framed in yellow (2 to 3 days) and then in red (more than 3).
export const DIAS_AMARILLO = 2;
export const DIAS_ROJO = 3;
export const antiguedadOf = (dias) => (dias > DIAS_ROJO ? 'roja' : dias >= DIAS_AMARILLO ? 'amarilla' : '');
export const haceDias = (dias) => (dias <= 0 ? 'hoy' : `hace ${dias} ${dias === 1 ? 'día' : 'días'}`);

// Today's date in the office's time zone, as YYYY-MM-DD. Days are counted here rather than in MySQL,
// whose clock may run in another time zone and would change the day at the wrong hour.
export const hoyLocal = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Hermosillo' });
// The first day of the month of hoy; a task sent before it is archived.
export const inicioMes = (hoy = hoyLocal()) => `${hoy.slice(0, 7)}-01`;
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / 86400000;
export const diasDesde = (fecha, hoy = hoyLocal()) => (fecha ? Math.max(0, Math.round(dayNumber(hoy) - dayNumber(fecha))) : 0);

const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

// The arrival date is typed once, when the task is registered: required, real and not in the future.
export function validarLlegada(value, hoy = hoyLocal()) {
  const fecha = String(value ?? '').trim();
  if (!fecha) return { error: 'Escriba la fecha de llegada.' };
  if (!isDate(fecha)) return { error: 'La fecha de llegada no es válida.' };
  if (fecha > hoy) return { error: 'La fecha de llegada no puede ser posterior a hoy.' };
  return { fecha };
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
// The description keeps its line breaks; only the ends are trimmed.
const cleanText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

const idOf = (value) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : null);

// Each task has one slot per job title, both optional. A slot takes one of the ids offered for it in the form
// (allowed: { licenciado: [ids], ingeniero: [ids] }); an empty value leaves it unassigned.
// The arrival date is checked apart, by validarLlegada, because only the new-task form sends it.
export function validarTarea({ titulo, descripcion, licenciado, ingeniero, estado }, allowed = {}) {
  const tarea = {
    titulo: clean(titulo),
    descripcion: cleanText(descripcion),
    licenciadoId: idOf(licenciado),
    ingenieroId: idOf(ingeniero),
    estado: ESTADOS.includes(estado) ? estado : 'pendiente',
  };
  if (!tarea.titulo) return { error: 'Escriba el título de la tarea.', field: 'titulo' };
  if (tarea.titulo.length > MAX_LENGTHS.titulo) return { error: 'El título es demasiado largo.', field: 'titulo' };
  if (tarea.descripcion.length > MAX_LENGTHS.descripcion) return { error: 'La descripción es demasiado larga.', field: 'descripcion' };
  const values = { licenciado, ingeniero };
  const wrong = userPuestos.find((puesto) => clean(values[puesto]) && !(allowed[puesto] || []).includes(tarea[`${puesto}Id`]));
  if (wrong) return { error: `Seleccione un ${puestoLabels[wrong].toLowerCase()} de la lista.`, field: wrong };
  return { tarea };
}

// A comment keeps its line breaks, like the description.
export function validarComentario(value) {
  const texto = cleanText(value);
  if (!texto) return { error: 'Escriba el comentario.' };
  if (texto.length > MAX_LENGTHS.comentario) return { error: 'El comentario es demasiado largo.' };
  return { texto };
}

// Only whoever created the task, an administrator or a semiadministrator may delete it.
export const puedeEliminar = (tarea, session) => session?.isAdmin === true || session?.role === 'semiadmin'
  || (tarea.creadorId != null && tarea.creadorId === Number(session?.userId));

// One board shared by every user outside UECS, who cannot open it.
// Tables made by earlier versions keep their unused posicion and fecha_limite columns.
export function createTareasStore(pool) {
  let storage;
  const initialize = () => {
    if (!storage) storage = pool.query(`CREATE TABLE IF NOT EXISTS tareas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(200) NOT NULL,
      descripcion TEXT NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      licenciado_id BIGINT NULL,
      ingeniero_id BIGINT NULL,
      fecha_llegada DATE NOT NULL,
      user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX tareas_estado_llegada (estado, fecha_llegada)
    )`).then(() => ensureUserPuesto(pool)).then(async () => {
      // The first version had a single responsable_id. Each assignee moves to the slot of their job title,
      // or to Licenciado when they have none yet; an administrator can correct it by editing the task.
      const [columns] = await pool.query('SHOW COLUMNS FROM tareas');
      const has = (name) => columns.some((column) => column.Field === name);
      if (!has('licenciado_id')) await pool.query('ALTER TABLE tareas ADD COLUMN licenciado_id BIGINT NULL AFTER estado');
      if (!has('ingeniero_id')) await pool.query('ALTER TABLE tareas ADD COLUMN ingeniero_id BIGINT NULL AFTER licenciado_id');
      if (has('responsable_id')) {
        await pool.query(`UPDATE tareas t LEFT JOIN users u ON u.id = t.responsable_id
          SET t.ingeniero_id = IF(u.puesto = 'ingeniero', t.responsable_id, t.ingeniero_id),
              t.licenciado_id = IF(u.puesto = 'ingeniero', t.licenciado_id, t.responsable_id)
          WHERE t.responsable_id IS NOT NULL`);
        await pool.query('ALTER TABLE tareas DROP COLUMN responsable_id');
      }
      // Tasks from before the arrival date existed arrived the day they were registered.
      if (!has('fecha_llegada')) {
        await pool.query('ALTER TABLE tareas ADD COLUMN fecha_llegada DATE NULL AFTER ingeniero_id');
        await pool.query('UPDATE tareas SET fecha_llegada = DATE(created_at) WHERE fecha_llegada IS NULL');
        await pool.query('ALTER TABLE tareas MODIFY fecha_llegada DATE NOT NULL');
      }
      // When the licenciado or the ingeniero marked their part of the task as done; NULL while it is not.
      for (const puesto of userPuestos) {
        if (!has(`${puesto}_listo_at`)) await pool.query(`ALTER TABLE tareas ADD COLUMN ${puesto}_listo_at DATETIME NULL`);
      }
      // The day a task went to Enviada, which decides when it leaves the board for the archive. Tasks already
      // there take the day they were last changed.
      if (!has('enviada_el')) {
        await pool.query('ALTER TABLE tareas ADD COLUMN enviada_el DATE NULL');
        await pool.query("UPDATE tareas SET enviada_el = DATE(updated_at) WHERE estado = 'enviada'");
      }
      // Each task's history: the comments people leave and a line for every change made to it.
      await pool.query(`CREATE TABLE IF NOT EXISTS tareas_historial (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tarea_id BIGINT UNSIGNED NOT NULL,
        tipo VARCHAR(20) NOT NULL,
        texto TEXT NOT NULL,
        user_id BIGINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX tareas_historial_tarea (tarea_id, id)
      )`);
    }).catch((error) => { storage = null; throw error; });
    return storage;
  };

  // Active users who can open the board and have a job title, the people a task can be assigned to.
  const responsables = async () => {
    await initialize();
    const [rows] = await pool.execute(`SELECT id, email, puesto FROM users
      WHERE is_active = 1 AND (role IS NULL OR role <> 'uecs') AND puesto IN (${userPuestos.map(() => '?').join(', ')}) ORDER BY email`, userPuestos);
    return rows.map((row) => ({ id: Number(row.id), email: row.email, puesto: row.puesto }));
  };

  const select = `SELECT t.id, t.titulo, t.descripcion, t.estado,
    t.licenciado_id AS licenciadoId, l.email AS licenciado, t.ingeniero_id AS ingenieroId, i.email AS ingeniero,
    DATE_FORMAT(t.licenciado_listo_at, '%d/%m/%Y %H:%i') AS licenciadoListo, DATE_FORMAT(t.ingeniero_listo_at, '%d/%m/%Y %H:%i') AS ingenieroListo,
    DATE_FORMAT(t.fecha_llegada, '%Y-%m-%d') AS fechaLlegada, DATE_FORMAT(t.enviada_el, '%Y-%m-%d') AS enviadaEl, t.user_id AS creadorId, c.email AS creador,
    DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i') AS actualizada, DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i:%s') AS version,
    (SELECT COUNT(*) FROM tareas_historial h WHERE h.tarea_id = t.id AND h.tipo = 'comentario') AS comentarios
    FROM tareas t LEFT JOIN users l ON l.id = t.licenciado_id LEFT JOIN users i ON i.id = t.ingeniero_id LEFT JOIN users c ON c.id = t.user_id`;
  const numberOrNull = (value) => (value == null ? null : Number(value));
  const normalize = (row) => ({
    ...row, id: Number(row.id), licenciadoId: numberOrNull(row.licenciadoId), ingenieroId: numberOrNull(row.ingenieroId),
    creadorId: numberOrNull(row.creadorId), comentarios: Number(row.comentarios ?? 0),
    llegada: row.fechaLlegada ? row.fechaLlegada.split('-').reverse().join('/') : '', dias: diasDesde(row.fechaLlegada),
    enviada: row.enviadaEl ? row.enviadaEl.split('-').reverse().join('/') : '',
  });
  // Tasks sent before the current month are archived: they leave the board and are listed by archivo.
  const archivada = "t.estado = 'enviada' AND t.enviada_el IS NOT NULL AND t.enviada_el < ?";
  // The day a task enters Enviada is kept while it stays there and dropped when it leaves. MySQL applies SET left
  // to right, so this goes before estado changes.
  const enviadaSet = "enviada_el = IF(? = 'enviada', IF(estado = 'enviada' AND enviada_el IS NOT NULL, enviada_el, ?), NULL)";

  // Every task, grouped by column with the oldest first; responsable filters by a user id in either slot,
  // or 'sin' for tasks with nobody.
  const board = async ({ responsable = '' } = {}, hoy = hoyLocal()) => {
    await initialize();
    let where = 'TRUE';
    const values = [];
    if (responsable === 'sin') where = 't.licenciado_id IS NULL AND t.ingeniero_id IS NULL';
    else if (/^\d+$/.test(String(responsable))) {
      where = '(t.licenciado_id = ? OR t.ingeniero_id = ?)';
      values.push(Number(responsable), Number(responsable));
    }
    const [rows] = await pool.execute(`${select} WHERE ${where} AND NOT (${archivada}) ORDER BY t.fecha_llegada, t.created_at, t.id`,
      [...values, inicioMes(hoy)]);
    const columns = Object.fromEntries(ESTADOS.map((estado) => [estado, []]));
    rows.map(normalize).forEach((row) => (columns[row.estado] ?? columns.pendiente).push(row));
    return columns;
  };

  // The archived tasks, latest sent first, optionally only those whose title, description or assignees contain buscar.
  const archivo = async ({ buscar = '' } = {}, hoy = hoyLocal()) => {
    await initialize();
    const texto = clean(buscar);
    const filtro = texto ? " AND CONCAT_WS(' ', t.titulo, t.descripcion, l.email, i.email) LIKE ?" : '';
    const [rows] = await pool.execute(`${select} WHERE ${archivada}${filtro} ORDER BY t.enviada_el DESC, t.id DESC`,
      [inicioMes(hoy), ...(texto ? [`%${texto}%`] : [])]);
    return rows.map(normalize);
  };

  const get = async (id) => {
    await initialize();
    const [rows] = await pool.execute(`${select} WHERE t.id = ?`, [id]);
    return rows[0] ? normalize(rows[0]) : null;
  };

  // The only place the arrival date is written; update leaves it as it was.
  const create = async (tarea, session) => {
    await initialize();
    const [result] = await pool.execute(
      'INSERT INTO tareas (titulo, descripcion, estado, licenciado_id, ingeniero_id, fecha_llegada, user_id, enviada_el) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tarea.titulo, tarea.descripcion, tarea.estado, tarea.licenciadoId, tarea.ingenieroId, tarea.fechaLlegada, session?.userId ?? null,
        tarea.estado === 'enviada' ? hoyLocal() : null],
    );
    return result.insertId;
  };

  // Columns are ordered by arrival, so a move only changes the column.
  const move = async (id, estado) => {
    await initialize();
    if (!ESTADOS.includes(estado)) return false;
    const [result] = await pool.execute(`UPDATE tareas SET ${enviadaSet}, estado = ? WHERE id = ?`, [estado, hoyLocal(), estado, id]);
    return result.affectedRows === 1;
  };

  // A slot given to someone else loses its done mark, which belonged to the person who had it. MySQL applies SET
  // left to right, so the marks are compared with the slots before the slots change.
  // version is the task's updated_at when the form was opened; given, the task is only saved if nobody changed it since,
  // and false comes back otherwise, as for a task that does not exist.
  const update = async (id, tarea, version = '') => {
    await initialize();
    const [result] = await pool.execute(`UPDATE tareas SET
      licenciado_listo_at = IF(licenciado_id <=> ?, licenciado_listo_at, NULL), ingeniero_listo_at = IF(ingeniero_id <=> ?, ingeniero_listo_at, NULL),
      ${enviadaSet}, titulo = ?, descripcion = ?, licenciado_id = ?, ingeniero_id = ?, estado = ? WHERE id = ?${version ? ' AND updated_at = ?' : ''}`,
    [tarea.licenciadoId, tarea.ingenieroId, tarea.estado, hoyLocal(), tarea.titulo, tarea.descripcion, tarea.licenciadoId, tarea.ingenieroId, tarea.estado, id,
      ...(version ? [version] : [])]);
    return result.affectedRows === 1;
  };

  // Marks or clears the done mark of one slot. Only the person in that slot may change it, so the mark always
  // names who finished; returns false when the task does not exist or the slot is someone else's.
  const marcarListo = async (id, puesto, userId, listo) => {
    await initialize();
    if (!userPuestos.includes(puesto)) return false;
    const [result] = await pool.execute(`UPDATE tareas SET ${puesto}_listo_at = ${listo ? 'NOW()' : 'NULL'} WHERE id = ? AND ${puesto}_id = ?`,
      [id, Number(userId)]);
    return result.affectedRows === 1;
  };

  const remove = async (id, session) => {
    const current = await get(id);
    if (!current) return 'no-encontrada';
    if (!puedeEliminar(current, session)) return 'sin-permiso';
    await pool.execute('DELETE FROM tareas WHERE id = ?', [id]);
    await pool.execute('DELETE FROM tareas_historial WHERE tarea_id = ?', [id]);
    return 'eliminada';
  };

  // Adds a line to a task's history: tipo is 'comentario' for what someone wrote, 'cambio' for a change the board recorded.
  const registrar = async (tareaId, tipo, texto, userId) => {
    await initialize();
    await pool.execute('INSERT INTO tareas_historial (tarea_id, tipo, texto, user_id) VALUES (?, ?, ?, ?)',
      [tareaId, tipo, texto, userId == null ? null : Number(userId)]);
  };

  // A task's history, oldest first.
  const historial = async (tareaId) => {
    await initialize();
    const [rows] = await pool.execute(`SELECT h.id, h.tipo, h.texto, u.email AS autor, DATE_FORMAT(h.created_at, '%d/%m/%Y %H:%i') AS fecha
      FROM tareas_historial h LEFT JOIN users u ON u.id = h.user_id WHERE h.tarea_id = ? ORDER BY h.id`, [tareaId]);
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  };

  return { initialize, responsables, board, archivo, get, create, move, update, marcarListo, remove, registrar, historial };
}
