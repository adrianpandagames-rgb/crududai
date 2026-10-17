import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { coverageSector, destination } from '../public/js/planeacion-geometry.js';

const SIZE = 768;
const CACHE = new URL('../data/map-tiles/', import.meta.url);
const pending = new Map();
const WEEK = 7 * 24 * 60 * 60 * 1000;

export function validateAntennaMap(query) {
  const number = (key, fallback) => {
    const value = query[key] ?? fallback;
    if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error('Indica latitud, longitud y azimut con punto decimal.');
    return Number(value);
  };
  const lat = number('lat');
  const lng = number('lng');
  const azimuth = query.azimuth === undefined ? null : number('azimuth');
  const radius = number('radius', '500');
  if (!Number.isFinite(lat) || Math.abs(lat) > 85 || !Number.isFinite(lng) || Math.abs(lng) > 180
      || (azimuth !== null && (!Number.isFinite(azimuth) || azimuth < 0 || azimuth > 360))
      || !Number.isFinite(radius) || radius < 1 || radius > 10000) {
    throw new Error('Latitud: -85 a 85; longitud: -180 a 180; azimut: 0 a 360 (360 = todas las direcciones); alcance: 1 a 10000 m.');
  }
  return { lat, lng, azimuth, radius };
}

function project(lat, lng, zoom) {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return [(lng + 180) / 360 * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}

async function loadTile(z, x, y) {
  const key = `${z}-${x}-${y}`;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const imageFile = new URL(`${key}.png`, CACHE);
    const metadataFile = new URL(`${key}.json`, CACHE);
    try {
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
      if (metadata.expires > Date.now()) return await readFile(imageFile);
    } catch { /* Missing or expired cache: request only a visible tile. */ }
    const response = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
      headers: { 'User-Agent': 'CrudUdai-AntennaMap/1.0 (Telegram antenna coverage viewer)' },
      signal: AbortSignal.timeout(12000), redirect: 'error',
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) throw new Error('Map tiles unavailable');
    const image = Buffer.from(await response.arrayBuffer());
    const info = await sharp(image).metadata();
    if (info.width !== 256 || info.height !== 256) throw new Error('Invalid map tile');
    const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 0);
    await mkdir(CACHE, { recursive: true });
    await writeFile(imageFile, image);
    await writeFile(metadataFile, JSON.stringify({ expires: Date.now() + Math.max(WEEK, maxAge * 1000) }));
    return image;
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}

export async function generateAntennaMap({ lat, lng, azimuth = null, radius = 500 }, { tileLoader = loadTile } = {}) {
  // Keep the entire radius inside a north-up viewport, including high latitudes.
  const metresAtZoomZero = 40075016.686 * Math.cos(lat * Math.PI / 180) / 256;
  const zoom = Math.max(0, Math.min(18, Math.floor(Math.log2(metresAtZoomZero * (SIZE / 2 - 60) / radius))));
  const [cx, cy] = project(lat, lng, zoom);
  const left = Math.floor(cx - SIZE / 2), top = Math.floor(cy - SIZE / 2);
  const tileLeft = Math.floor(left / 256), tileTop = Math.floor(top / 256);
  const tileRight = Math.floor((left + SIZE - 1) / 256), tileBottom = Math.floor((top + SIZE - 1) / 256);
  const width = (tileRight - tileLeft + 1) * 256;
  const height = (tileBottom - tileTop + 1) * 256;
  const tiles = [];
  const requests = [];
  const count = 2 ** zoom;
  // Request only this viewport, in small batches, with a persistent tile cache.
  for (let y = tileTop; y <= tileBottom; y++) {
    for (let x = tileLeft; x <= tileRight; x++) {
      if (y < 0 || y >= count) continue;
      requests.push({ z: zoom, x: ((x % count) + count) % count, y,
        left: (x - tileLeft) * 256, top: (y - tileTop) * 256 });
    }
  }
  for (let index = 0; index < requests.length; index += 4) {
    const batch = await Promise.all(requests.slice(index, index + 4).map(async (tile) => ({
      input: await tileLoader(tile.z, tile.x, tile.y), left: tile.left, top: tile.top,
    })));
    tiles.push(...batch);
  }
  const background = await sharp({ create: { width, height, channels: 3, background: '#edf1f3' } })
    .composite(tiles).png().toBuffer();
  const cropped = await sharp(background).extract({ left: left - tileLeft * 256, top: top - tileTop * 256, width: SIZE, height: SIZE }).png().toBuffer();
  const world = 256 * 2 ** zoom;
  const points = azimuth === null ? [] : azimuth === 360
    ? Array.from({ length: 120 }, (_, index) => destination(lat, lng, index * 3, radius))
    : coverageSector(lat, lng, azimuth, radius);
  const path = points.map(([phi, lambda]) => {
    const [x, y] = project(phi, lambda, zoom);
    const dx = ((x - cx + world / 2) % world + world) % world - world / 2;
    return `${(cx + dx - left).toFixed(2)},${(y - top).toFixed(2)}`;
  }).join(' ');
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    ${azimuth === null ? '' : `<polygon points="${path}" fill="#168cff" fill-opacity="0.25" stroke="#087cf0" stroke-width="2"/>`}
    <circle cx="${cx - left}" cy="${cy - top}" r="6" fill="#16456b" stroke="white" stroke-width="2"/>
    <rect x="0" y="740" width="768" height="28" fill="white" fill-opacity="0.9"/>
    <text x="12" y="759" font-family="sans-serif" font-size="13" fill="#253746">© OpenStreetMap contributors · openstreetmap.org/copyright</text>
  </svg>`);
  return sharp(cropped).composite([{ input: overlay }]).png().toBuffer();
}
