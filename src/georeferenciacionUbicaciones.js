import { recoverLegacyAddressDetails } from './georeferenciacionFormato.js';

export async function initializeGeocodingLocations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS georeferenciacion_ubicaciones (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ubicacion TEXT NOT NULL,
    lugar VARCHAR(500) NOT NULL,
    latitude DECIMAL(12,9) NOT NULL,
    longitude DECIMAL(12,9) NOT NULL,
    UNIQUE KEY geo_coordinates (latitude, longitude)
  )`);
  const [columns] = await pool.query('SHOW COLUMNS FROM georeferenciacion_ubicaciones');
  for (const [name, definition] of [
    ['entre_calle_1', "VARCHAR(500) NOT NULL DEFAULT ''"],
    ['entre_calle_2', "VARCHAR(500) NOT NULL DEFAULT ''"],
    ['estado_entrecalles', "VARCHAR(40) NOT NULL DEFAULT 'REQUIERE_REVISION'"],
    ['componentes_direccion', 'JSON NULL'],
  ]) {
    if (!columns.some((column) => column.Field === name)) {
      await pool.query(`ALTER TABLE georeferenciacion_ubicaciones ADD COLUMN ${name} ${definition}`);
    }
  }
}

export async function findGeocodingLocation(pool, latitude, longitude) {
  const [rows] = await pool.execute(`SELECT ubicacion, lugar, entre_calle_1, entre_calle_2, estado_entrecalles, componentes_direccion
    FROM georeferenciacion_ubicaciones
    WHERE latitude = CAST(? AS DECIMAL(12,9)) AND longitude = CAST(? AS DECIMAL(12,9)) LIMIT 1`,
  [latitude, longitude]);
  const location = rows[0];
  if (!location) return null;
  const details = typeof location.componentes_direccion === 'string' ? JSON.parse(location.componentes_direccion) : location.componentes_direccion;
  const addressDetails = details || recoverLegacyAddressDetails(location.ubicacion);
  return {
    ...(addressDetails ? { addressDetails, street: addressDetails.street } : {}),
    address: location.ubicacion,
    place: location.lugar,
    betweenStreet1: location.entre_calle_1 || '',
    betweenStreet2: location.entre_calle_2 || '',
    crossStreetStatus: location.estado_entrecalles || 'REQUIERE_REVISION',
    status: 'OK',
  };
}

export async function saveGeocodingLocation(pool, location) {
  await pool.execute(`INSERT INTO georeferenciacion_ubicaciones (ubicacion, lugar, latitude, longitude, entre_calle_1, entre_calle_2, estado_entrecalles, componentes_direccion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ubicacion = VALUES(ubicacion), lugar = VALUES(lugar),
    entre_calle_1 = VALUES(entre_calle_1), entre_calle_2 = VALUES(entre_calle_2), estado_entrecalles = VALUES(estado_entrecalles),
    componentes_direccion = COALESCE(VALUES(componentes_direccion), componentes_direccion)`,
  [location.ubicacion, location.lugar, location.latitude, location.longitude, location.entre_calle_1 || '', location.entre_calle_2 || '', location.estado_entrecalles || 'REQUIERE_REVISION',
    location.componentes_direccion ? JSON.stringify(location.componentes_direccion) : null]);
}

export async function listGeocodingLocations(pool, query = {}) {
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 200) : '';
  const requestedPage = Math.max(1, Math.min(1000000, Number.parseInt(query.page, 10) || 1));
  const where = search ? " WHERE CONCAT_WS(' ', ubicacion, lugar, latitude, longitude, entre_calle_1, entre_calle_2) LIKE ?" : '';
  const parameters = search ? [`%${search}%`] : [];
  const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM georeferenciacion_ubicaciones' + where, parameters);
  const total = Number(count.total);
  const pages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(requestedPage, pages);
  const [locations] = await pool.query('SELECT ubicacion, lugar, latitude, longitude, entre_calle_1, entre_calle_2, estado_entrecalles FROM georeferenciacion_ubicaciones' + where + ' ORDER BY id DESC LIMIT 25 OFFSET ?', [...parameters, (page - 1) * 25]);
  return { locations, search, total, page, pages };
}
