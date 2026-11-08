import https from "https";

const PHONE_VALIDATION_API_URL = 'https://apilayer.net/api/validate';

const normalizePhoneNumber = (value) => String(value || '').replace(/\D/g, '');
// A validation answer is a few hundred bytes.
const MAX_RESPONSE_BYTES = 64 * 1024;

// Every lookup spends the operator's paid apilayer plan, so each person gets a daily allowance and the whole
// app a daily ceiling (both configurable), and a number looked up again within a day is answered from memory.
const positiveInt = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
export const PHONE_LIMITS = {
  perUser: positiveInt(process.env.PHONE_VALIDATION_DAILY_LIMIT_PER_USER, 30),
  global: positiveInt(process.env.PHONE_VALIDATION_DAILY_LIMIT, 300),
};
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED = 2000;
const cache = new Map();
const usage = { day: '', total: 0, byUser: new Map() };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Hermosillo' });

const reserveLookup = (userId) => {
  const day = today();
  if (usage.day !== day) Object.assign(usage, { day, total: 0, byUser: new Map() });
  const key = String(userId ?? 'anon');
  const used = usage.byUser.get(key) || 0;
  const limitError = (message) => Object.assign(new Error(message), { status: 429 });
  if (used >= PHONE_LIMITS.perUser) throw limitError(`Llegaste al límite de ${PHONE_LIMITS.perUser} consultas telefónicas por día. Intenta mañana.`);
  if (usage.total >= PHONE_LIMITS.global) throw limitError('Se alcanzó el límite diario de consultas telefónicas de la aplicación. Intenta mañana.');
  usage.byUser.set(key, used + 1);
  usage.total += 1;
};
export const resetPhoneValidationUsage = () => { Object.assign(usage, { day: '', total: 0, byUser: new Map() }); cache.clear(); };

const requestPhoneValidation = (url) => new Promise((resolve, reject) => {
  const request = https.get(url, { headers: { Accept: 'application/json' }, timeout: 10000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_RESPONSE_BYTES) request.destroy(new Error('La respuesta del servicio es demasiado grande.'));
    });
    response.on('end', () => {
      try {
        resolve({ statusCode: response.statusCode, data: JSON.parse(body) });
      } catch {
        reject(new Error('La respuesta del servicio no tiene un formato válido.'));
      }
    });
  });

  request.on('timeout', () => request.destroy(new Error('La consulta telefónica tardó demasiado.')));
  request.on('error', reject);
});

const validatePhoneNumber = async (rawNumber, { userId, request = requestPhoneValidation } = {}) => {
  const digits = normalizePhoneNumber(rawNumber);
  if (digits.length < 7 || digits.length > 15) {
    const error = new Error('Ingresa un número telefónico de 7 a 15 dígitos, incluyendo el código de país.');
    error.status = 400;
    throw error;
  }

  const accessKey = process.env.PHONE_VALIDATION_ACCESS_KEY;
  if (!accessKey) {
    const error = new Error('La consulta telefónica no está configurada en el servidor.');
    error.status = 503;
    throw error;
  }

  const cached = cache.get(digits);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  reserveLookup(userId);

  const query = new URLSearchParams({
    access_key: accessKey,
    number: `+${digits}`,
    country_code: '',
    format: '1',
  });
  try {
    const { statusCode, data } = await request(`${PHONE_VALIDATION_API_URL}?${query.toString()}`);

    if (statusCode < 200 || statusCode >= 300 || !data) {
      const error = new Error('El servicio de validación telefónica no respondió correctamente.');
      error.status = 502;
      throw error;
    }

    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(digits, { at: Date.now(), data });
    return data;
  } catch (cause) {
    if (cause.status) throw cause;
    const error = new Error(cause.name === 'AbortError'
      ? 'La consulta telefónica tardó demasiado. Intenta nuevamente.'
      : 'No fue posible consultar el servicio de validación telefónica.');
    error.status = 502;
    throw error;
  }
};

export { validatePhoneNumber };
