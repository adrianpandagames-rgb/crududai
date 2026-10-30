import { ensureUserPuesto, puestoLabels, userPuestos } from './usuariosService.js';

// The board's columns, left to right.
export const ESTADOS = ['pendiente', 'en_proceso', 'falta_oficio', 'terminada', 'enviada'];
export const ESTADO_LABELS = {
  pendiente: 'Pendiente', en_proceso: 'En proceso', falta_oficio: 'Falta oficio', terminada: 'Terminada', enviada: 'Enviada',
};
export const MAX_LENGTHS = { titulo: 200, descripcion: 2000 };

// Whole days since a task arrived before its card is framed in yellow (2 to 3 days) and then in red (more than 3).
export const DIAS_AMARILLO = 2;
export const DIAS_ROJO = 3;
export const antiguedadOf = (dias) => (dias > DIAS_ROJO ? 'roja' : dias >= DIAS_AMARILLO ? 'amarilla' : '');
export const haceDias = (dias) => (dias <= 0 ? 'hoy' : `hace ${dias} ${dias === 1 ? 'día' : 'días'}`);

// Today's date in the office's time zone, as YYYY-MM-DD. Days are counted here rather than in MySQL,
// whose clock may run in another time zone and would change the day at the wrong hour.
export const hoyLocal = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Hermosillo' });
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
    DATE_FORMAT(t.fecha_llegada, '%Y-%m-%d') AS fechaLlegada, t.user_id AS creadorId, c.email AS creador,
    DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i') AS actualizada
    FROM tareas t LEFT JOIN users l ON l.id = t.licenciado_id LEFT JOIN users i ON i.id = t.ingeniero_id LEFT JOIN users c ON c.id = t.user_id`;
  const numberOrNull = (value) => (value == null ? null : Number(value));
  const normalize = (row) => ({
    ...row, id: Number(row.id), licenciadoId: numberOrNull(row.licenciadoId), ingenieroId: numberOrNull(row.ingenieroId),
    creadorId: numberOrNull(row.creadorId),
    llegada: row.fechaLlegada ? row.fechaLlegada.split('-').reverse().join('/') : '', dias: diasDesde(row.fechaLlegada),
  });

  // Every task, grouped by column with the oldest first; responsable filters by a user id in either slot,
  // or 'sin' for tasks with nobody.
  const board = async ({ responsable = '' } = {}) => {
    await initialize();
    let where = 'TRUE';
    const values = [];
    if (responsable === 'sin') where = 't.licenciado_id IS NULL AND t.ingeniero_id IS NULL';
    else if (/^\d+$/.test(String(responsable))) {
      where = '(t.licenciado_id = ? OR t.ingeniero_id = ?)';
      values.push(Number(responsable), Number(responsable));
    }
    const [rows] = await pool.execute(`${select} WHERE ${where} ORDER BY t.fecha_llegada, t.created_at, t.id`, values);
    const columns = Object.fromEntries(ESTADOS.map((estado) => [estado, []]));
    rows.map(normalize).forEach((row) => (columns[row.estado] ?? columns.pendiente).push(row));
    return columns;
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
      'INSERT INTO tareas (titulo, descripcion, estado, licenciado_id, ingeniero_id, fecha_llegada, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tarea.titulo, tarea.descripcion, tarea.estado, tarea.licenciadoId, tarea.ingenieroId, tarea.fechaLlegada, session?.userId ?? null],
    );
    return result.insertId;
  };

  // Columns are ordered by arrival, so a move only changes the column.
  const move = async (id, estado) => {
    await initialize();
    if (!ESTADOS.includes(estado)) return false;
    const [result] = await pool.execute('UPDATE tareas SET estado = ? WHERE id = ?', [estado, id]);
    return result.affectedRows === 1;
  };

  const update = async (id, tarea) => {
    await initialize();
    const [result] = await pool.execute('UPDATE tareas SET titulo = ?, descripcion = ?, licenciado_id = ?, ingeniero_id = ?, estado = ? WHERE id = ?',
      [tarea.titulo, tarea.descripcion, tarea.licenciadoId, tarea.ingenieroId, tarea.estado, id]);
    return result.affectedRows === 1;
  };

  const remove = async (id, session) => {
    const current = await get(id);
    if (!current) return 'no-encontrada';
    if (!puedeEliminar(current, session)) return 'sin-permiso';
    await pool.execute('DELETE FROM tareas WHERE id = ?', [id]);
    return 'eliminada';
  };

  return { initialize, responsables, board, get, create, move, update, remove };
}
