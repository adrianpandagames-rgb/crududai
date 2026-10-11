import { findCrossStreets } from './entrecallesService.js';

export async function initializeLocalRoads(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS georeferenciacion_red_vial (
    dataset CHAR(36) NOT NULL, osm_id BIGINT NOT NULL,
    min_lat DOUBLE NOT NULL, max_lat DOUBLE NOT NULL, min_lon DOUBLE NOT NULL, max_lon DOUBLE NOT NULL,
    elements JSON NOT NULL, PRIMARY KEY (dataset, osm_id), INDEX vial_lat (dataset, min_lat)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS georeferenciacion_red_vial_version (
    region VARCHAR(40) PRIMARY KEY, dataset CHAR(36) NOT NULL,
    road_count INT NOT NULL, imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
}

export async function getLocalRoadStatus(pool) {
  const [rows] = await pool.execute("SELECT dataset, road_count, imported_at FROM georeferenciacion_red_vial_version WHERE region = 'sonora'");
  return rows[0] || null;
}

export function createLocalCrossStreetLookup(pool) {
  const cache = new Map();
  let version;
  return async (latitude, longitude, { street, signal } = {}) => {
    if (signal?.aborted) throw new Error('Procesamiento cancelado.');
    if (version === undefined) version = await getLocalRoadStatus(pool);
    if (!version) return { betweenStreet1: '', betweenStreet2: '', crossStreetStatus: 'RED_LOCAL_NO_CARGADA' };
    const lat = Math.round(latitude * 100) / 100, lon = Math.round(longitude * 100) / 100;
    const key = `${lat},${lon}`;
    if (!cache.has(key)) {
      // Includes the tile offset, 60m snapping distance and 800m walks in either direction.
      const marginLat = .018, marginLon = .018 / Math.max(.1, Math.cos(latitude * Math.PI / 180));
      const [rows] = await pool.execute(`SELECT elements FROM georeferenciacion_red_vial
        WHERE dataset = ? AND min_lat <= ? AND max_lat >= ? AND min_lon <= ? AND max_lon >= ?`,
      [version.dataset, lat + marginLat, lat - marginLat, lon + marginLon, lon - marginLon]);
      const elements = new Map();
      for (const row of rows) for (const element of typeof row.elements === 'string' ? JSON.parse(row.elements) : row.elements) {
        elements.set(`${element.type}:${element.id}`, element);
      }
      if (cache.size >= 50) cache.delete(cache.keys().next().value);
      cache.set(key, [...elements.values()]);
    }
    if (signal?.aborted) throw new Error('Procesamiento cancelado.');
    const elements = cache.get(key);
    const inferredStreet = inferLocalStreet(elements, latitude, longitude);
    if (!street) return findCrossStreets(elements, latitude, longitude, inferredStreet);

    const result = findCrossStreets(elements, latitude, longitude, street);
    if (result.crossStreetStatus === 'ENCONTRADAS') return result;
    if (!inferredStreet || normalizeStreet(inferredStreet) === normalizeStreet(street)) return result;

    const inferredResult = findCrossStreets(elements, latitude, longitude, inferredStreet);
    const resultCompleteness = Number(Boolean(result.betweenStreet1)) + Number(Boolean(result.betweenStreet2));
    const inferredCompleteness = Number(Boolean(inferredResult.betweenStreet1)) + Number(Boolean(inferredResult.betweenStreet2));
    return inferredResult.crossStreetStatus === 'ENCONTRADAS' || inferredCompleteness > resultCompleteness
      ? inferredResult : result;
  };
}

const normalizeStreet = (street) => String(street || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function inferLocalStreet(elements, latitude, longitude) {
  const nodes = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const distances = new Map();
  for (const way of elements.filter((e) => e.type === 'way')) {
    const name = way.tags?.name || way.tags?.['name:es'];
    if (!name) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = nodes.get(way.nodes[i - 1]), b = nodes.get(way.nodes[i]);
      if (!a || !b) continue;
      const scale = 111320 * Math.cos(latitude * Math.PI / 180);
      const ax = (a.lon - longitude) * scale, ay = (a.lat - latitude) * 111320;
      const dx = (b.lon - a.lon) * scale, dy = (b.lat - a.lat) * 111320;
      const length2 = dx * dx + dy * dy;
      if (!length2) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
      const distance = Math.hypot(ax + t * dx, ay + t * dy);
      distances.set(name, Math.min(distance, distances.get(name) ?? Infinity));
    }
  }
  const sorted = [...distances].sort((a, b) => a[1] - b[1]);
  if (!sorted.length || sorted[0][1] > 60 || (sorted[1] && sorted[1][1] - sorted[0][1] < 10)) return '';
  return sorted[0][0];
}
