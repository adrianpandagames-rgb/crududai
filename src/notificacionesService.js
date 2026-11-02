import { formatAuditTimestamp } from './auditFilters.js';

export const NOTIFICACIONES_POR_PAGINA = 20;
// Older notices are dropped whenever a new one arrives for that person.
const DIAS_CONSERVADOS = 90;

// Only links inside the app are kept, so a notice can never send someone elsewhere.
const urlInterna = (url) => (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url.slice(0, 255) : null);

export function createNotificacionesStore(pool) {
  let storage;
  const initialize = () => {
    if (!storage) storage = pool.query(`CREATE TABLE IF NOT EXISTS notificaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      titulo VARCHAR(120) NOT NULL,
      mensaje VARCHAR(500) NOT NULL,
      url VARCHAR(255) NULL,
      leida_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX notificaciones_usuario (user_id, leida_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch((error) => { storage = null; throw error; });
    return storage;
  };

  return {
    initialize,
    async crear(userId, { titulo, mensaje, url } = {}) {
      await initialize();
      await pool.execute('INSERT INTO notificaciones (user_id, titulo, mensaje, url) VALUES (?, ?, ?, ?)', [
        userId, String(titulo || 'Aviso').slice(0, 120), String(mensaje || '').slice(0, 500), urlInterna(url),
      ]);
      await pool.execute(`DELETE FROM notificaciones WHERE user_id = ? AND created_at < NOW() - INTERVAL ${DIAS_CONSERVADOS} DAY`, [userId]);
    },
    async noLeidas(userId) {
      await initialize();
      const [[row]] = await pool.execute('SELECT COUNT(*) AS total FROM notificaciones WHERE user_id = ? AND leida_at IS NULL', [userId]);
      return Number(row?.total) || 0;
    },
    async listar(userId, { page = 1, soloNoLeidas = false } = {}) {
      await initialize();
      const filtro = soloNoLeidas ? ' AND leida_at IS NULL' : '';
      const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM notificaciones WHERE user_id = ?${filtro}`, [userId]);
      const totalPages = Math.max(Math.ceil(Number(total) / NOTIFICACIONES_POR_PAGINA), 1);
      const currentPage = Math.min(Math.max(page, 1), totalPages);
      const [rows] = await pool.query(
        `SELECT id, titulo, mensaje, url, leida_at IS NOT NULL AS leida, UNIX_TIMESTAMP(created_at) AS creadaTs
         FROM notificaciones WHERE user_id = ?${filtro}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [userId, NOTIFICACIONES_POR_PAGINA, (currentPage - 1) * NOTIFICACIONES_POR_PAGINA],
      );
      return {
        notificaciones: rows.map(({ creadaTs, leida, ...row }) => ({ ...row, leida: Number(leida) === 1, creada: formatAuditTimestamp(creadaTs) })),
        total: Number(total),
        currentPage,
        totalPages,
      };
    },
    // Returns the notice's link, so opening it can take the person there; null when it is not theirs.
    async marcarLeida(id, userId) {
      await initialize();
      const [rows] = await pool.execute('SELECT url FROM notificaciones WHERE id = ? AND user_id = ?', [id, userId]);
      if (!rows.length) return null;
      await pool.execute('UPDATE notificaciones SET leida_at = COALESCE(leida_at, NOW()) WHERE id = ? AND user_id = ?', [id, userId]);
      return { url: rows[0].url || '' };
    },
    async marcarTodas(userId) {
      await initialize();
      await pool.execute('UPDATE notificaciones SET leida_at = NOW() WHERE user_id = ? AND leida_at IS NULL', [userId]);
    },
    async eliminarLeidas(userId) {
      await initialize();
      await pool.execute('DELETE FROM notificaciones WHERE user_id = ? AND leida_at IS NOT NULL', [userId]);
    },
  };
}
