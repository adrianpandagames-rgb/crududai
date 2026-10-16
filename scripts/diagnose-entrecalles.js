import pool from '../src/db.js';
import { parseCoordinateNumber } from '../src/rutaService.js';
import { findGeocodingLocation, saveGeocodingLocation } from '../src/georeferenciacionUbicaciones.js';
import { formatGeocodingLocation } from '../src/georeferenciacionFormato.js';
import { getLocalRoadStatus, createLocalCrossStreetLookup, inferLocalStreet } from '../src/redVialLocal.js';
import { findCrossStreets } from '../src/entrecallesService.js';
const coordinates = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const latitude = parseCoordinateNumber(coordinates[0] || `31°19'30.21"N`);
const longitude = parseCoordinateNumber(coordinates[1] || `110°55'48.1"W`);
try {
  const saved = await findGeocodingLocation(pool, latitude, longitude);
  const version = await getLocalRoadStatus(pool);
  console.log({ latitude, longitude, saved });
  const [rows] = await pool.execute(`SELECT elements FROM georeferenciacion_red_vial WHERE dataset = ?
    AND min_lat <= ? AND max_lat >= ? AND min_lon <= ? AND max_lon >= ?`,
  [version.dataset, latitude + .02, latitude - .02, longitude + .025, longitude - .025]);
  const elementsMap = new Map();
  for (const row of rows) for (const element of typeof row.elements === 'string' ? JSON.parse(row.elements) : row.elements) elementsMap.set(`${element.type}:${element.id}`, element);
  const elements = [...elementsMap.values()];
  const nodes = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const near = elements.filter((e) => e.type === 'way').map((way) => {
    let distance = Infinity, segment;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = nodes.get(way.nodes[i - 1]), b = nodes.get(way.nodes[i]);
      const scale = 111320 * Math.cos(latitude * Math.PI / 180);
      const ax = (a.lon - longitude) * scale, ay = (a.lat - latitude) * 111320;
      const dx = (b.lon - a.lon) * scale, dy = (b.lat - a.lat) * 111320;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < distance) { distance = d; segment = { a: a.id, b: b.id, t, length: Math.hypot(dx, dy) }; }
    }
    return { id: way.id, tags: way.tags, distance: Math.round(distance * 10) / 10, segment,
      result: findCrossStreets(elements, latitude, longitude, way.tags.name) };
  }).sort((a, b) => a.distance - b.distance).slice(0, 8);
  const targetWays = elements.filter((e) => e.type === 'way' && e.tags.name === near[0].tags.name);
  const targetNodes = new Set(targetWays.flatMap((w) => w.nodes));
  const connections = [...targetNodes].map((id) => ({ id, node: nodes.get(id),
    ways: elements.filter((e) => e.type === 'way' && e.nodes.includes(id)).map((w) => ({ id: w.id, name: w.tags.name, nodes: w.nodes })) }));
  const lookup = await createLocalCrossStreetLookup(pool)(latitude, longitude, { street: saved?.street });
  console.log(JSON.stringify({ ...(process.argv.includes('--details') ? { targetWays, connections, near } : {}),
    roads: rows.length, inferred: inferLocalStreet(elements, latitude, longitude), lookup }, null, 2));
  if (saved && process.argv.includes('--save')) {
    const formatted = formatGeocodingLocation({ ...saved, ...lookup });
    await saveGeocodingLocation(pool, { ubicacion: formatted.address, lugar: formatted.place, latitude, longitude,
      entre_calle_1: lookup.betweenStreet1, entre_calle_2: lookup.betweenStreet2,
      estado_entrecalles: lookup.crossStreetStatus, componentes_direccion: saved.addressDetails });
    console.log('Ubicación actualizada con los cruces disponibles.');
  }
} finally { await pool.end(); }
