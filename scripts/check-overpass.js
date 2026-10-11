import 'dotenv/config';
const endpoints = [...new Set([process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter',
  process.env.OVERPASS_FALLBACK_API_URL ?? 'https://overpass.private.coffee/api/interpreter'].filter(Boolean))];
const query = '[out:json][timeout:20];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$"](around:2000,29.08,-110.96);(._;>;);out body;';
for (const endpoint of endpoints) {
  try {
    const useGet = process.argv.includes('--get');
    const url = new URL(endpoint);
    if (useGet) url.searchParams.set('data', query);
    const response = await fetch(url, { method: useGet ? 'GET' : 'POST', headers: { 'User-Agent': 'CRUD-UDAI/1.0 (cross-street lookup)', Accept: 'application/json' }, body: useGet ? undefined : new URLSearchParams({ data: query }), signal: AbortSignal.timeout(25000) });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch {}
    console.log(new URL(endpoint).hostname, response.status, data ? { elements: data.elements?.length, remark: data.remark } : body.slice(0, 300));
    if (!response.ok || !Array.isArray(data?.elements) || data.remark) process.exitCode = 1;
  } catch (error) {
    console.log(new URL(endpoint).hostname, error.name, error.cause?.code || 'TIMEOUT_OR_NETWORK_ERROR');
    process.exitCode = 1;
  }
}
