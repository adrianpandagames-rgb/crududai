// Catalog of "carpeta resguardo" options offered in the Inspecciones form.
export function validarNombreCarpetaResguardo(raw) {
  const nombre = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!nombre || nombre.length > 255) throw new Error('Carpeta resguardo: escribe entre 1 y 255 caracteres.');
  return nombre;
}

export async function crearTablaCarpetasResguardo(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS CarpetasResguardo (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    creado_por BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY carpetas_resguardo_nombre (nombre)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

export async function agregarColumnaCarpetaResguardo(db) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    ['Inspecciones', 'carpeta_resguardo'],
  );
  if (!rows.length) await db.query('ALTER TABLE Inspecciones ADD COLUMN carpeta_resguardo VARCHAR(255) NULL');
}

export async function listarCarpetasResguardo(db) {
  const [rows] = await db.execute('SELECT nombre FROM CarpetasResguardo ORDER BY nombre');
  return rows.map(row => row.nombre);
}

// Returns the stored spelling, so "bodega 1" reuses an existing "Bodega 1".
export async function agregarCarpetaResguardo(db, raw, userId) {
  const nombre = validarNombreCarpetaResguardo(raw);
  await db.execute('INSERT IGNORE INTO CarpetasResguardo (nombre, creado_por) VALUES (?, ?)', [nombre, userId]);
  const [[row]] = await db.execute('SELECT nombre FROM CarpetasResguardo WHERE nombre = ?', [nombre]);
  return row.nombre;
}

export async function carpetaResguardoExiste(db, nombre) {
  if (nombre == null) return true;
  const [rows] = await db.execute('SELECT 1 FROM CarpetasResguardo WHERE nombre = ? LIMIT 1', [nombre]);
  return rows.length > 0;
}
