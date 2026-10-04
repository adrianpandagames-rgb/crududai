export async function initializeGeocodingLocations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS georeferenciacion_ubicaciones (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ubicacion TEXT NOT NULL,
    lugar VARCHAR(500) NOT NULL,
    latitude DECIMAL(12,9) NOT NULL,
    longitude DECIMAL(12,9) NOT NULL,
    UNIQUE KEY geo_coordinates (latitude, longitude)
  )`);
}

export async function saveGeocodingLocation(pool, location) {
  await pool.execute(`INSERT INTO georeferenciacion_ubicaciones (ubicacion, lugar, latitude, longitude)
    VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE ubicacion = VALUES(ubicacion), lugar = VALUES(lugar)`,
  [location.ubicacion, location.lugar, location.latitude, location.longitude]);
}

export async function listGeocodingLocations(pool, query = {}) {
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 200) : '';
  const requestedPage = Math.max(1, Math.min(1000000, Number.parseInt(query.page, 10) || 1));
  const where = search ? " WHERE CONCAT_WS(' ', ubicacion, lugar, latitude, longitude) LIKE ?" : '';
  const parameters = search ? [`%${search}%`] : [];
  const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM georeferenciacion_ubicaciones' + where, parameters);
  const total = Number(count.total);
  const pages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(requestedPage, pages);
  const [locations] = await pool.query('SELECT ubicacion, lugar, latitude, longitude FROM georeferenciacion_ubicaciones' + where + ' ORDER BY id DESC LIMIT 25 OFFSET ?', [...parameters, (page - 1) * 25]);
  return { locations, search, total, page, pages };
}
