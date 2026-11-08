// How each person arranges a table: column order, widths, pinned columns and row density. public/js/tablas.js
// sends it; every value is re-checked here, since the browser is not trusted to send clean data.

export const densidades = ['compacta', 'normal', 'amplia'];
export const MIN_ANCHO = 48;
export const MAX_ANCHO = 1200;
const MAX_COLUMNAS = 40;
const columnaValida = (id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id);
export const tablaValida = (tabla) => typeof tabla === 'string' && /^[a-z0-9-]{1,60}$/.test(tabla);

const listaDeColumnas = (value) => (Array.isArray(value) ? [...new Set(value.filter(columnaValida))].slice(0, MAX_COLUMNAS) : []);

// Returns null when nothing differs from how the table looks by default, so a reset leaves no row behind.
export function normalizarConfigTabla(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const anchos = {};
  if (value.anchos && typeof value.anchos === 'object' && !Array.isArray(value.anchos)) {
    for (const [id, ancho] of Object.entries(value.anchos).slice(0, MAX_COLUMNAS)) {
      const px = Math.round(Number(ancho));
      if (columnaValida(id) && Number.isFinite(px)) anchos[id] = Math.min(Math.max(px, MIN_ANCHO), MAX_ANCHO);
    }
  }
  const config = {
    orden: listaDeColumnas(value.orden),
    anchos,
    fijas: listaDeColumnas(value.fijas),
    densidad: densidades.includes(value.densidad) ? value.densidad : 'normal',
  };
  const vacia = !config.orden.length && !Object.keys(anchos).length && !config.fijas.length && config.densidad === 'normal';
  return vacia ? null : config;
}

export function createTablasStore(pool) {
  let storage;
  const initialize = () => {
    if (!storage) storage = pool.query(`CREATE TABLE IF NOT EXISTS user_tablas (
      user_id INT NOT NULL,
      tabla VARCHAR(60) NOT NULL,
      config TEXT NOT NULL,
      actualizada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, tabla)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch((error) => { storage = null; throw error; });
    return storage;
  };

  return {
    initialize,
    async listar(userId) {
      await initialize();
      const [rows] = await pool.execute('SELECT tabla, config FROM user_tablas WHERE user_id = ?', [userId]);
      const tablas = {};
      for (const { tabla, config } of rows) {
        const limpia = normalizarConfigTabla(config);
        if (limpia) tablas[tabla] = limpia;
      }
      return tablas;
    },
    // A null config goes back to the default layout.
    async guardar(userId, tabla, config) {
      await initialize();
      if (!config) {
        await pool.execute('DELETE FROM user_tablas WHERE user_id = ? AND tabla = ?', [userId, tabla]);
        return;
      }
      await pool.execute(
        `INSERT INTO user_tablas (user_id, tabla, config) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE config = VALUES(config)`,
        [userId, tabla, JSON.stringify(config)],
      );
    },
  };
}
