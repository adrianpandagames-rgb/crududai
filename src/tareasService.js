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

// The responsible person must be one of the users offered in the form; an empty value leaves the task unassigned.
export function validarTarea({ titulo, descripcion, responsable, fechaLimite, estado }, responsableIds = []) {
  const tarea = {
    titulo: clean(titulo),
    descripcion: cleanText(descripcion),
    responsableId: /^\d+$/.test(String(responsable ?? '')) ? Number(responsable) : null,
    fechaLimite: clean(fechaLimite) || null,
    estado: ESTADOS.includes(estado) ? estado : 'pendiente',
  };
  if (!tarea.titulo) return { error: 'Escriba el título de la tarea.', field: 'titulo' };
  if (tarea.titulo.length > MAX_LENGTHS.titulo) return { error: 'El título es demasiado largo.', field: 'titulo' };
  if (tarea.descripcion.length > MAX_LENGTHS.descripcion) return { error: 'La descripción es demasiado larga.', field: 'descripcion' };
  if (clean(responsable) && !responsableIds.includes(tarea.responsableId)) {
    return { error: 'Seleccione un responsable de la lista.', field: 'responsable' };
  }
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
      responsable_id BIGINT NULL,
      fecha_limite DATE NULL,
      user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX tareas_estado (estado, posicion)
    )`).catch((error) => { storage = null; throw error; });
    return storage;
  };

  // Active users who can open the board, the people a task can be assigned to.
  const responsables = async () => {
    const [rows] = await pool.execute("SELECT id, email FROM users WHERE is_active = 1 AND (role IS NULL OR role <> 'uecs') ORDER BY email");
    return rows.map((row) => ({ id: Number(row.id), email: row.email }));
  };

  const select = `SELECT t.id, t.titulo, t.descripcion, t.estado, t.posicion, t.responsable_id AS responsableId, r.email AS responsable,
    DATE_FORMAT(t.fecha_limite, '%Y-%m-%d') AS fechaLimite, t.user_id AS creadorId, c.email AS creador,
    DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i') AS actualizada
    FROM tareas t LEFT JOIN users r ON r.id = t.responsable_id LEFT JOIN users c ON c.id = t.user_id`;
  const normalize = (row) => ({
    ...row, id: Number(row.id), responsableId: row.responsableId == null ? null : Number(row.responsableId),
    creadorId: row.creadorId == null ? null : Number(row.creadorId),
  });

  // Every task, grouped by column; responsable filters by a user id, or 'sin' for unassigned tasks.
  const board = async ({ responsable = '' } = {}) => {
    await initialize();
    let where = 'TRUE';
    const values = [];
    if (responsable === 'sin') where = 't.responsable_id IS NULL';
    else if (/^\d+$/.test(String(responsable))) {
      where = 't.responsable_id = ?';
      values.push(Number(responsable));
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
      `INSERT INTO tareas (titulo, descripcion, estado, posicion, responsable_id, fecha_limite, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tarea.titulo, tarea.descripcion, tarea.estado, Number(siguiente), tarea.responsableId, tarea.fechaLimite, session?.userId ?? null],
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
    await pool.execute('UPDATE tareas SET titulo = ?, descripcion = ?, responsable_id = ?, fecha_limite = ? WHERE id = ?',
      [tarea.titulo, tarea.descripcion, tarea.responsableId, tarea.fechaLimite, id]);
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
