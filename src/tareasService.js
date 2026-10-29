import { ensureUserPuesto, puestoLabels, userPuestos } from './usuariosService.js';

// The board's columns, left to right.
export const ESTADOS = ['pendiente', 'en_proceso', 'terminada'];
export const ESTADO_LABELS = { pendiente: 'Pendiente', en_proceso: 'En proceso', terminada: 'Terminada' };
export const MAX_LENGTHS = { titulo: 200, descripcion: 2000 };

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
// The description keeps its line breaks; only the ends are trimmed.
const cleanText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const idOf = (value) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : null);

// Each task has one slot per job title, both optional. A slot takes one of the ids offered for it in the form
// (allowed: { licenciado: [ids], ingeniero: [ids] }); an empty value leaves it unassigned.
export function validarTarea({ titulo, descripcion, licenciado, ingeniero, fechaLimite, estado }, allowed = {}) {
  const tarea = {
    titulo: clean(titulo),
    descripcion: cleanText(descripcion),
    licenciadoId: idOf(licenciado),
    ingenieroId: idOf(ingeniero),
    fechaLimite: clean(fechaLimite) || null,
    estado: ESTADOS.includes(estado) ? estado : 'pendiente',
  };
  if (!tarea.titulo) return { error: 'Escriba el título de la tarea.', field: 'titulo' };
  if (tarea.titulo.length > MAX_LENGTHS.titulo) return { error: 'El título es demasiado largo.', field: 'titulo' };
  if (tarea.descripcion.length > MAX_LENGTHS.descripcion) return { error: 'La descripción es demasiado larga.', field: 'descripcion' };
  const values = { licenciado, ingeniero };
  const wrong = userPuestos.find((puesto) => clean(values[puesto]) && !(allowed[puesto] || []).includes(tarea[`${puesto}Id`]));
  if (wrong) return { error: `Seleccione un ${puestoLabels[wrong].toLowerCase()} de la lista.`, field: wrong };
  if (tarea.fechaLimite && !isDate(tarea.fechaLimite)) return { error: 'La fecha límite no es válida.', field: 'fechaLimite' };
  return { tarea };
}

// Only whoever created the task, an administrator or a semiadministrator may delete it.
export const puedeEliminar = (tarea, session) => session?.isAdmin === true || session?.role === 'semiadmin'
  || (tarea.creadorId != null && tarea.creadorId === Number(session?.userId));

// One board shared by every user outside UECS, who cannot open it.
export function createTareasStore(pool) {
  let storage;
  const initialize = () => {
    if (!storage) storage = pool.query(`CREATE TABLE IF NOT EXISTS tareas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(200) NOT NULL,
      descripcion TEXT NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      posicion INT NOT NULL DEFAULT 0,
      licenciado_id BIGINT NULL,
      ingeniero_id BIGINT NULL,
      fecha_limite DATE NULL,
      user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX tareas_estado (estado, posicion)
    )`).then(() => ensureUserPuesto(pool)).then(async () => {
      // The first version had a single responsable_id. Each assignee moves to the slot of their job title,
      // or to Licenciado when they have none yet; an administrator can correct it by editing the task.
      const [columns] = await pool.query('SHOW COLUMNS FROM tareas');
      const has = (name) => columns.some((column) => column.Field === name);
      if (!has('licenciado_id')) await pool.query('ALTER TABLE tareas ADD COLUMN licenciado_id BIGINT NULL AFTER posicion');
      if (!has('ingeniero_id')) await pool.query('ALTER TABLE tareas ADD COLUMN ingeniero_id BIGINT NULL AFTER licenciado_id');
      if (has('responsable_id')) {
        await pool.query(`UPDATE tareas t LEFT JOIN users u ON u.id = t.responsable_id
          SET t.ingeniero_id = IF(u.puesto = 'ingeniero', t.responsable_id, t.ingeniero_id),
              t.licenciado_id = IF(u.puesto = 'ingeniero', t.licenciado_id, t.responsable_id)
          WHERE t.responsable_id IS NOT NULL`);
        await pool.query('ALTER TABLE tareas DROP COLUMN responsable_id');
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

  const select = `SELECT t.id, t.titulo, t.descripcion, t.estado, t.posicion,
    t.licenciado_id AS licenciadoId, l.email AS licenciado, t.ingeniero_id AS ingenieroId, i.email AS ingeniero,
    DATE_FORMAT(t.fecha_limite, '%Y-%m-%d') AS fechaLimite, t.user_id AS creadorId, c.email AS creador,
    DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i') AS actualizada
    FROM tareas t LEFT JOIN users l ON l.id = t.licenciado_id LEFT JOIN users i ON i.id = t.ingeniero_id LEFT JOIN users c ON c.id = t.user_id`;
  const numberOrNull = (value) => (value == null ? null : Number(value));
  const normalize = (row) => ({
    ...row, id: Number(row.id), licenciadoId: numberOrNull(row.licenciadoId), ingenieroId: numberOrNull(row.ingenieroId),
    creadorId: numberOrNull(row.creadorId),
  });

  // Every task, grouped by column; responsable filters by a user id in either slot, or 'sin' for tasks with nobody.
  const board = async ({ responsable = '' } = {}) => {
    await initialize();
    let where = 'TRUE';
    const values = [];
    if (responsable === 'sin') where = 't.licenciado_id IS NULL AND t.ingeniero_id IS NULL';
    else if (/^\d+$/.test(String(responsable))) {
      where = '(t.licenciado_id = ? OR t.ingeniero_id = ?)';
      values.push(Number(responsable), Number(responsable));
    }
    const [rows] = await pool.execute(`${select} WHERE ${where} ORDER BY t.posicion, t.id`, values);
    const columns = Object.fromEntries(ESTADOS.map((estado) => [estado, []]));
    rows.map(normalize).forEach((row) => (columns[row.estado] ?? columns.pendiente).push(row));
    return columns;
  };

  const get = async (id) => {
    await initialize();
    const [rows] = await pool.execute(`${select} WHERE t.id = ?`, [id]);
    return rows[0] ? normalize(rows[0]) : null;
  };

  // New tasks go to the end of their column.
  const create = async (tarea, session) => {
    await initialize();
    const [[{ siguiente }]] = await pool.execute('SELECT COALESCE(MAX(posicion), -1) + 1 AS siguiente FROM tareas WHERE estado = ?', [tarea.estado]);
    const [result] = await pool.execute(
      `INSERT INTO tareas (titulo, descripcion, estado, posicion, licenciado_id, ingeniero_id, fecha_limite, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tarea.titulo, tarea.descripcion, tarea.estado, Number(siguiente), tarea.licenciadoId, tarea.ingenieroId, tarea.fechaLimite,
        session?.userId ?? null],
    );
    return result.insertId;
  };

  // Places the task in column estado just before task antesDe (at the end when it is not there) and renumbers that column,
  // inside a transaction so two people dropping cards at once do not leave repeated positions.
  // A neighbour id, rather than an index, keeps the order right while the board shows only one person's tasks.
  const move = async (id, estado, antesDe = null) => {
    await initialize();
    if (!ESTADOS.includes(estado)) return false;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [found] = await connection.execute('SELECT id FROM tareas WHERE id = ? FOR UPDATE', [id]);
      if (!found[0]) {
        await connection.rollback();
        return false;
      }
      const [rows] = await connection.execute('SELECT id FROM tareas WHERE estado = ? AND id <> ? ORDER BY posicion, id FOR UPDATE', [estado, id]);
      const ids = rows.map((row) => Number(row.id));
      const index = ids.indexOf(Number(antesDe));
      ids.splice(index === -1 ? ids.length : index, 0, Number(id));
      await connection.execute('UPDATE tareas SET estado = ? WHERE id = ?', [estado, id]);
      for (const [order, taskId] of ids.entries()) {
        await connection.execute('UPDATE tareas SET posicion = ? WHERE id = ?', [order, taskId]);
      }
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };

  // A change of column through the edit form puts the task at the end of the new column.
  const update = async (id, tarea) => {
    const current = await get(id);
    if (!current) return false;
    await pool.execute('UPDATE tareas SET titulo = ?, descripcion = ?, licenciado_id = ?, ingeniero_id = ?, fecha_limite = ? WHERE id = ?',
      [tarea.titulo, tarea.descripcion, tarea.licenciadoId, tarea.ingenieroId, tarea.fechaLimite, id]);
    if (current.estado !== tarea.estado) await move(id, tarea.estado, null);
    return true;
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
