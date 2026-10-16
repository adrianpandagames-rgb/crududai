import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import parseOSM from 'osm-pbf-parser';
import pool from '../src/db.js';
import { initializeLocalRoads } from '../src/redVialLocal.js';

// Sonora and a border buffer. Shared node IDs are preserved to distinguish bridges.
const inRegion = (n) => n.lat >= 26 && n.lat <= 33 && n.lon >= -115 && n.lon <= -108;
const roadTypes = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$/;
const file = process.argv[2] || 'data/osm/mexico-latest.osm.pbf';
const dataset = randomUUID();
let roads = 0, nodesRead = 0;
const nodes = new Map();
let batch = [];
const flush = async () => {
  if (!batch.length) return;
  await pool.query(`INSERT INTO georeferenciacion_red_vial
    (dataset, osm_id, min_lat, max_lat, min_lon, max_lon, elements) VALUES ?`, [batch]);
  roads += batch.length;
  batch = [];
};
try {
  await stat(file);
  await initializeLocalRoads(pool);
  console.log('Leyendo mapa OSM; se conservarán las calles de Sonora y su zona limítrofe.');
  await pipeline(createReadStream(file), parseOSM(), async (source) => {
    for await (const items of source) {
      for (const item of items) {
        if (item.type === 'node') {
          nodesRead++;
          if (inRegion(item)) nodes.set(item.id, [item.lat, item.lon]);
        } else if (item.type === 'way' && roadTypes.test(item.tags?.highway)) {
          if (item.refs.length < 2 || !item.refs.every((id) => nodes.has(id))) continue;
          const geometry = item.refs.map((id) => { const [lat, lon] = nodes.get(id); return { type: 'node', id, lat, lon }; });
          const tags = Object.fromEntries(['highway', 'name', 'name:es', 'alt_name'].filter((key) => item.tags[key]).map((key) => [key, item.tags[key]]));
          const elements = [{ type: 'way', id: item.id, nodes: item.refs, tags }, ...geometry];
          const lats = geometry.map((n) => n.lat), lons = geometry.map((n) => n.lon);
          batch.push([dataset, item.id, Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons), JSON.stringify(elements)]);
          if (batch.length >= 100) await flush();
        }
      }
      if (roads && roads % 5000 === 0) console.log(`${roads} tramos importados.`);
    }
  });
  await flush();
  if (!roads || !nodesRead) throw new Error('El archivo no contiene una red vial válida para Sonora.');
  await pool.execute(`INSERT INTO georeferenciacion_red_vial_version (region, dataset, road_count)
    VALUES ('sonora', ?, ?) ON DUPLICATE KEY UPDATE dataset = VALUES(dataset), road_count = VALUES(road_count), imported_at = NOW()`, [dataset, roads]);
  console.log(`Red local activada: ${roads} tramos. Las importaciones anteriores permanecen intactas.`);
} catch (error) {
  console.error('No se activó la nueva red vial:', error.code || error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
