import pool from '../src/db.js';
import { getLocalRoadStatus, createLocalCrossStreetLookup } from '../src/redVialLocal.js';
try {
  const status = await getLocalRoadStatus(pool);
  if (!status) throw new Error('Red local no cargada');
  console.log(`Red local: ${status.road_count} tramos.`);
  const [rows] = await pool.execute(`SELECT elements FROM georeferenciacion_red_vial
    WHERE dataset = ? AND min_lat BETWEEN 29.07 AND 29.10 AND min_lon BETWEEN -110.97 AND -110.94 LIMIT 300`, [status.dataset]);
  const lookup = createLocalCrossStreetLookup(pool);
  let checked = 0, found = 0;
  for (const row of rows) {
    const elements = typeof row.elements === 'string' ? JSON.parse(row.elements) : row.elements;
    const way = elements.find((e) => e.type === 'way');
    if (!way.tags.name) continue;
    const nodes = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
    const index = Math.floor((way.nodes.length - 1) / 2);
    const a = nodes.get(way.nodes[index]), b = nodes.get(way.nodes[index + 1]);
    const result = await lookup((a.lat + b.lat) / 2, (a.lon + b.lon) / 2, { street: way.tags.name });
    checked++;
    if (result.crossStreetStatus === 'ENCONTRADAS') found++;
    if (checked >= 50) break;
  }
  console.log(`Prueba local sin servicios externos: ${checked} puntos de muestra, ${found} con dos entrecalles; ${checked - found} requieren revisión.`);
  if (!found) throw new Error('No se encontraron entrecalles en la muestra');
} catch (error) {
  console.error(error.code || error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
