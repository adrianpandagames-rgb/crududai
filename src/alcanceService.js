import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

// Estimated reach of a sector from how close the operator's other sites are, using the OpenCelliD dump of
// Mexico (MCC 334) kept on the server. OpenCelliD gives the average position of the measurements of each cell,
// not the tower, so cells are first merged into pseudo-sites. This is a heuristic for planning, never a
// measured coverage: the result always carries the method that produced it.

export const OPERATORS = {
  telcel: { label: 'Telcel', mnc: [20] },
  att: { label: 'AT&T', mnc: [50, 90] },
  movistar: { label: 'Movistar', mnc: [3, 30] },
  altan: { label: 'Altán (Red Compartida)', mnc: [140] },
  todos: { label: 'Todos los operadores', mnc: null },
};

export const SETTINGS = {
  minSamples: 3, // cells measured fewer times have an unreliable position
  mergeMetres: 500, // cells closer than this belong to the same pseudo-site
  selfMetres: 600, // the pseudo-site this close to the antenna is the antenna itself
  halfWedge: 60, // neighbours within azimuth ± this many degrees limit the sector
  searchMetres: 15000,
  factor: 0.6, // share of the distance to the nearest neighbour the sector reaches
  minRange: 300,
  maxRange: 10000,
  noNeighbourRange: 5000, // nothing ahead within the search radius (road, sierra, border)
};

const EARTH = 6371008.8;
const RAD = Math.PI / 180;
const GRID = 0.05; // degrees per index cell, about 5.5 km

export function distance(lat1, lng1, lat2, lng2) {
  const dPhi = (lat2 - lat1) * RAD;
  const dLambda = (lng2 - lng1) * RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const gridKey = (lat, lng) => `${Math.floor(lat / GRID)},${Math.floor(lng / GRID)}`;

// OpenCelliD columns: radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal
export function parseCells(text, settings = SETTINGS) {
  const cells = [];
  for (const line of text.split('\n')) {
    const field = line.split(',');
    if (field.length < 10 || field[0] === 'radio') continue;
    const [mnc, lng, lat, samples] = [Number(field[2]), Number(field[6]), Number(field[7]), Number(field[9])];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(samples >= settings.minSamples)) continue;
    cells.push({ mnc, lat, lng, samples });
  }
  return cells;
}

// Greedy merge, best-measured cells first, so each pseudo-site is anchored on its most reliable cell.
export function buildSites(cells, settings = SETTINGS) {
  const sites = [];
  const index = new Map();
  for (const cell of [...cells].sort((a, b) => b.samples - a.samples)) {
    const [row, col] = [Math.floor(cell.lat / GRID), Math.floor(cell.lng / GRID)];
    let match = null;
    for (let r = row - 1; r <= row + 1 && !match; r++) {
      for (let c = col - 1; c <= col + 1 && !match; c++) {
        match = (index.get(`${r},${c}`) || []).find((site) => site.mnc === cell.mnc
          && distance(site.lat, site.lng, cell.lat, cell.lng) <= settings.mergeMetres) || null;
      }
    }
    if (match) {
      const weight = match.samples + cell.samples;
      match.lat = (match.lat * match.samples + cell.lat * cell.samples) / weight;
      match.lng = (match.lng * match.samples + cell.lng * cell.samples) / weight;
      match.samples = weight;
      continue;
    }
    const site = { mnc: cell.mnc, lat: cell.lat, lng: cell.lng, samples: cell.samples };
    sites.push(site);
    const key = gridKey(site.lat, site.lng);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(site);
  }
  // Re-index on final positions for the queries.
  const finalIndex = new Map();
  for (const site of sites) {
    const key = gridKey(site.lat, site.lng);
    if (!finalIndex.has(key)) finalIndex.set(key, []);
    finalIndex.get(key).push(site);
  }
  return { sites, index: finalIndex };
}

function nearbySites({ index }, lat, lng, metres, mnc) {
  const span = Math.ceil(metres / 111000 / GRID) + 1;
  const lngSpan = Math.ceil(span / Math.max(Math.cos(lat * RAD), 0.2));
  const [row, col] = [Math.floor(lat / GRID), Math.floor(lng / GRID)];
  const found = [];
  for (let r = row - span; r <= row + span; r++) {
    for (let c = col - lngSpan; c <= col + lngSpan; c++) {
      for (const site of index.get(`${r},${c}`) || []) {
        if (mnc && !mnc.includes(site.mnc)) continue;
        const metresAway = distance(lat, lng, site.lat, site.lng);
        if (metresAway <= metres) found.push({ site, metres: metresAway });
      }
    }
  }
  return found.sort((a, b) => a.metres - b.metres);
}

const clamp = (value, settings) => Math.round(Math.min(Math.max(value, settings.minRange), settings.maxRange));

// Returns { range, method, neighbour? } for one antenna. Without azimuth every direction counts as "ahead".
export function estimateRange(sites, antenna, mnc, settings = SETTINGS) {
  const around = nearbySites(sites, antenna.lat, antenna.lng, settings.searchMetres, mnc)
    .filter((entry) => entry.metres > settings.selfMetres);
  const hasAzimuth = Number.isFinite(antenna.azimuth);
  const ahead = hasAzimuth
    ? around.filter((entry) => angleGap(bearing(antenna.lat, antenna.lng, entry.site.lat, entry.site.lng), antenna.azimuth) <= settings.halfWedge)
    : around;
  if (ahead.length) {
    return { range: clamp(ahead[0].metres * settings.factor, settings), method: 'vecinos', neighbour: Math.round(ahead[0].metres) };
  }
  return { range: settings.noNeighbourRange, method: around.length ? 'sin-vecinos-sector' : 'sin-datos' };
}

let loaded = null;
export function loadSites(file = process.env.OPENCELLID_FILE || '/srv/opencellid/334.csv.gz') {
  if (!loaded) {
    loaded = readFile(file).then((buffer) => buildSites(parseCells(gunzipSync(buffer).toString('utf8'))));
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}
