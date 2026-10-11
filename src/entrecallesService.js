const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pending = (status = 'REQUIERE_REVISION') => ({ betweenStreet1: '', betweenStreet2: '', crossStreetStatus: status });
const roadTypes = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$/;

// Shared OSM nodes represent actual connections; geometric crossings alone may be bridges.
export function findCrossStreets(elements, latitude, longitude, street) {
  if (!normalize(street)) return pending();
  const nodes = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const ways = elements.filter((e) => e.type === 'way' && roadTypes.test(e.tags?.highway) && e.nodes?.length > 1);
  const matching = ways.filter((w) => [w.tags.name, w.tags['name:es'], ...(w.tags.alt_name || '').split(';')].some((n) => normalize(n) === normalize(street)));
  const graph = new Map();
  const memberships = new Map();
  for (const way of ways) for (const id of way.nodes) {
    if (!memberships.has(id)) memberships.set(id, []);
    memberships.get(id).push(way);
  }
  const xy = (node) => [(node.lon - longitude) * 111320 * Math.cos(latitude * Math.PI / 180), (node.lat - latitude) * 111320];
  const isPerpendicularAt = (way, nodeId, routeDirection) => {
    const routeLength = Math.hypot(...routeDirection);
    if (!routeLength) return false;
    for (let index = 0; index < way.nodes.length; index += 1) {
      if (way.nodes[index] !== nodeId) continue;
      for (const neighborId of [way.nodes[index - 1], way.nodes[index + 1]]) {
        const neighbor = nodes.get(neighborId), intersection = nodes.get(nodeId);
        if (!neighbor || !intersection) continue;
        const [x1, y1] = xy(intersection), [x2, y2] = xy(neighbor);
        const direction = [x2 - x1, y2 - y1];
        const length = Math.hypot(...direction);
        if (length && Math.abs((direction[0] * routeDirection[0] + direction[1] * routeDirection[1]) / (length * routeLength)) <= Math.SQRT1_2) {
          return true;
        }
      }
    }
    return false;
  };
  let closest;
  for (const way of matching) for (let i = 1; i < way.nodes.length; i++) {
    const a = way.nodes[i - 1], b = way.nodes[i];
    if (!nodes.has(a) || !nodes.has(b)) continue;
    const [ax, ay] = xy(nodes.get(a)), [bx, by] = xy(nodes.get(b));
    const length = Math.hypot(bx - ax, by - ay);
    if (!length) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!graph.has(from)) graph.set(from, new Map());
      graph.get(from).set(to, length);
    }
    const t = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / length ** 2));
    const distance = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
    if (!closest || distance < closest.distance) closest = { a, b, t, length, distance };
  }
  if (!closest || closest.distance > 60) return pending();
  let ambiguous = false;
  const walk = (start, previous, initialDistance) => {
    let current = start, traveled = initialDistance;
    const visited = new Set([previous]);
    while (traveled <= 800 && !visited.has(current)) {
      visited.add(current);
      const previousPoint = nodes.get(previous), currentPoint = nodes.get(current);
      const [previousX, previousY] = xy(previousPoint), [currentX, currentY] = xy(currentPoint);
      const routeDirection = [currentX - previousX, currentY - previousY];
      const intersecting = (memberships.get(current) || [])
        .filter((w) => !matching.includes(w) && isPerpendicularAt(w, current, routeDirection));
      const crosses = [...new Set(intersecting.map((w) => w.tags.name || w.tags['name:es']).filter(Boolean))];
      if (intersecting.length) {
        if (crosses.length !== 1 || !intersecting.every((w) => w.tags.name || w.tags['name:es'])) ambiguous = true;
        return crosses.join(' / ');
      }
      const next = [...(graph.get(current) || [])].filter(([id]) => id !== previous);
      if (next.length !== 1) return '';
      previous = current;
      [current] = next[0];
      traveled += next[0][1];
    }
    return '';
  };
  // Points close to an intersection cannot reliably be assigned to one block.
  if ([[closest.a, closest.t * closest.length], [closest.b, (1 - closest.t) * closest.length]]
    .some(([id, distance]) => distance < 8 && (memberships.get(id) || []).some((w) => !matching.includes(w)))) return pending();
  const first = walk(closest.a, closest.b, closest.t * closest.length);
  const second = walk(closest.b, closest.a, (1 - closest.t) * closest.length);
  return { betweenStreet1: first, betweenStreet2: second,
    crossStreetStatus: first && second && !ambiguous && normalize(first) !== normalize(second) ? 'ENCONTRADAS' : 'REQUIERE_REVISION' };
}

const primaryEndpoint = 'https://overpass-api.de/api/interpreter';
const fallbackEndpoint = 'https://overpass.private.coffee/api/interpreter';

// Reuse nearby queries, fail over to another instance and retry after a cooldown.
export function createCrossStreetLookup({ fetchImpl = fetch, endpoint = process.env.OVERPASS_API_URL || primaryEndpoint,
  fallback = process.env.OVERPASS_FALLBACK_API_URL ?? (endpoint === primaryEndpoint ? fallbackEndpoint : ''),
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onError = (diagnostic) => console.warn('[Entrecalles]', diagnostic), cooldownMs = 60000 } = {}) {
  const cache = new Map();
  const endpoints = [...new Set([endpoint, fallback].filter(Boolean))];
  let unavailableUntil = 0;
  let preferred = endpoint;
  let lastRequest = 0;
  return async (latitude, longitude, { street, signal } = {}) => {
    if (signal?.aborted) throw new Error('Procesamiento cancelado.');
    if (!normalize(street)) return pending();
    const lat = Math.round(latitude * 100) / 100, lon = Math.round(longitude * 100) / 100;
    const key = `${lat},${lon}`;
    if (!cache.has(key) && now() < unavailableUntil) return pending('SERVICIO_NO_DISPONIBLE');
    try {
      if (!cache.has(key)) {
        const query = `[out:json][timeout:20];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$"](around:2000,${lat},${lon});(._;>;);out body;`;
        for (const provider of [preferred, ...endpoints.filter((item) => item !== preferred)]) {
          let failure = 'NETWORK_ERROR';
          try {
            const pause = Math.max(0, 1100 - (now() - lastRequest));
            if (pause) await sleep(pause);
            if (signal?.aborted) throw new Error('Procesamiento cancelado.');
            lastRequest = now();
            const response = await fetchImpl(provider, {
              method: 'POST', headers: { 'User-Agent': 'CRUD-UDAI/1.0 (cross-street lookup)', Accept: 'application/json' },
              body: new URLSearchParams({ data: query }),
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
            });
            failure = `HTTP_${response.status}`;
            if (!response.ok) throw new Error('Overpass unavailable');
            failure = 'INVALID_RESPONSE';
            const data = await response.json();
            if (data.remark || !Array.isArray(data.elements)) throw new Error('Incomplete road data');
            if (cache.size >= 50) cache.delete(cache.keys().next().value);
            cache.set(key, data.elements);
            preferred = provider;
            unavailableUntil = 0;
            break;
          } catch (error) {
            if (signal?.aborted) throw new Error('Procesamiento cancelado.');
            const hostname = (() => { try { return new URL(provider).hostname; } catch { return 'invalid-endpoint'; } })();
            onError({ provider: hostname, reason: failure === 'NETWORK_ERROR' ? error.cause?.code || error.name : failure });
          }
        }
        if (!cache.has(key)) {
          unavailableUntil = now() + cooldownMs;
          return pending('SERVICIO_NO_DISPONIBLE');
        }
      }
      return findCrossStreets(cache.get(key), latitude, longitude, street);
    } catch {
      if (signal?.aborted) throw new Error('Procesamiento cancelado.');
      unavailableUntil = now() + cooldownMs;
      return pending('SERVICIO_NO_DISPONIBLE');
    }
  };
}