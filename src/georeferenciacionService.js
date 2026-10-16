import { parseCsv, detectCsvDelimiter, normalizeRutaValue, parseCoordinateNumber, readRutaXlsxRows } from './rutaService.js';
import { createCrossStreetLookup } from './entrecallesService.js';
import { formatGeocodingLocation } from './georeferenciacionFormato.js';

export const getGeocodingKey = () => process.env.GOOGLE_GEOCODING_API_KEY || '';

export function readGeocodingFile(buffer, extension) {
  const text = extension === '.csv' ? buffer.toString('utf8').replace(/^\uFEFF/, '') : '';
  const delimiter = extension === '.csv' ? detectCsvDelimiter(text) : ',';
  const rows = extension === '.xlsx' ? readRutaXlsxRows(buffer) : parseCsv(text, delimiter);
  if (rows.length < 2) throw new Error('El archivo debe contener encabezados y al menos una fila de datos.');
  if (rows.length > 100001) throw new Error('El archivo supera el límite de 100000 filas.');
  const headers = rows[0].map(normalizeRutaValue);
  const latitude = headers.findIndex((h) => /^(latitud|latitude|lat)$/.test(h));
  const longitude = headers.findIndex((h) => /^(longitud|longitude|lon|lng|long)$/.test(h));
  if (latitude < 0 || longitude < 0) throw new Error('El archivo debe incluir las columnas latitud y longitud.');
  return { rows, delimiter, latitude, longitude };
}

export async function reverseGeocode(latitude, longitude, { apiKey = getGeocodingKey(), fetchImpl = fetch, signal } = {}) {
  if (!apiKey) throw new Error('Falta configurar GOOGLE_GEOCODING_API_KEY en el servidor.');
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.search = new URLSearchParams({ latlng: `${latitude},${longitude}`, language: 'es', key: apiKey }).toString();
  let data;
  try {
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('HTTP');
    data = await response.json();
  } catch {
    if (signal?.aborted) throw new Error('Procesamiento cancelado.');
    throw new Error('No fue posible comunicarse con Google Geocoding. Intenta nuevamente más tarde.');
  }
  if (data.status === 'ZERO_RESULTS') return { address: '', place: '', status: 'SIN_RESULTADOS' };
  if (data.status !== 'OK') {
    const messages = {
      REQUEST_DENIED: 'Google rechazó la consulta. Revisa la clave, las restricciones y la activación de Geocoding API.',
      OVER_QUERY_LIMIT: 'Se alcanzó el límite de consultas de Google Geocoding.',
      OVER_DAILY_LIMIT: 'Revisa la cuota y la facturación de Google Geocoding.',
      INVALID_REQUEST: 'Google rechazó las coordenadas enviadas.',
    };
    throw new Error(messages[data.status] || 'Google Geocoding no pudo completar la consulta. Intenta nuevamente más tarde.');
  }
  const result = data.results?.[0];
  if (!result?.formatted_address) throw new Error('Google devolvió una respuesta sin dirección.');
  const components = result.address_components || [];
  const component = (type) => components.find((item) => item.types?.includes(type))?.long_name;
  const addressDetails = {
    street: component('route') || '',
    neighborhood: component('neighborhood') || component('sublocality_level_1') || component('sublocality') || '',
    postalCode: component('postal_code') || '',
    city: component('locality') || component('postal_town') || '',
    state: component('administrative_area_level_1') || '',
    originalAddress: result.formatted_address,
  };
  return {
    address: result.formatted_address,
    street: component('route') || '',
    addressDetails,
    place: component('locality') || component('postal_town') || component('administrative_area_level_2') || component('administrative_area_level_1') || '',
    status: 'OK',
  };
}

export async function processGeocodingFile(input, { geocode = reverseGeocode, crossStreets = createCrossStreetLookup(), findLocation = async () => null, refreshStoredCrossStreets = false, signal, onProgress = async () => {}, onLocation = async () => {} } = {}) {
  const { rows, delimiter, latitude, longitude } = input;
  const headers = rows[0].slice();
  const column = (name) => {
    const index = headers.findIndex((h) => normalizeRutaValue(h) === name);
    if (index >= 0) return index;
    headers.push(name);
    return headers.length - 1;
  };
  const antenna = column('antena');
  const address = column('ubicacion');
  const place = column('lugar');
  const between1 = column('entre_calle_1');
  const between2 = column('entre_calle_2');
  const crossStatus = column('estado_entrecalles');
  const attribution = column('fuente_entrecalles');
  const status = column('estado_geocodificacion');
  const cache = new Map();
  const output = [headers];
  output.delimiter = delimiter;
  for (const source of rows.slice(1)) {
    if (signal?.aborted) throw new Error('Procesamiento cancelado.');
    const row = source.slice();
    while (row.length < headers.length) row.push('');
    const latText = String(source[latitude] ?? '').trim();
    const lngText = String(source[longitude] ?? '').trim();
    const lat = latText ? parseCoordinateNumber(latText, delimiter) : null;
    const lng = lngText ? parseCoordinateNumber(lngText, delimiter) : null;
    row[address] = '';
    row[place] = '';
    row[antenna] = '';
    row[between1] = '';
    row[between2] = '';
    row[crossStatus] = 'NO_APLICA';
    row[attribution] = '';
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      row[status] = 'COORDENADAS_INVALIDAS';
    } else {
      const key = `${lat},${lng}`;
      if (!cache.has(key)) {
        const saved = await findLocation(lat, lng);
        if (signal?.aborted) throw new Error('Procesamiento cancelado.');
        let result = saved || await geocode(lat, lng, { signal });
        const originalAddress = result.address, originalPlace = result.place;
        let refreshed = false;
        if (saved && refreshStoredCrossStreets && result.crossStreetStatus !== 'ENCONTRADAS') {
          const local = await crossStreets(lat, lng, { street: result.street, signal });
          if (local.crossStreetStatus !== 'RED_LOCAL_NO_CARGADA') {
            Object.assign(result, local);
            refreshed = true;
          }
        }
        if (!saved && result.status === 'OK') {
          Object.assign(result, await crossStreets(lat, lng, { street: result.street, signal }));
        }
        if (result.status === 'OK') result = formatGeocodingLocation(result);
        if (result.status === 'OK' && (!saved || refreshed || result.address !== originalAddress || result.place !== originalPlace)) {
          await onLocation({ ubicacion: result.address, lugar: result.place, latitude: lat, longitude: lng,
            entre_calle_1: result.betweenStreet1, entre_calle_2: result.betweenStreet2, estado_entrecalles: result.crossStreetStatus,
            componentes_direccion: result.addressDetails || null });
        }
        cache.set(key, { ...result, antenna: cache.size + 1 });
      }
      const result = cache.get(key);
      row[antenna] = result.antenna;
      row[address] = result.address;
      row[place] = result.place;
      row[status] = result.status;
      row[between1] = result.betweenStreet1 || '';
      row[between2] = result.betweenStreet2 || '';
      row[crossStatus] = result.crossStreetStatus || 'NO_APLICA';
      row[attribution] = result.betweenStreet1 ? '© OpenStreetMap contributors https://www.openstreetmap.org/copyright' : '';
    }
    output.push(row);
    if ((output.length - 1) % 25 === 0 || output.length === rows.length) await onProgress(output.length - 1);
  }
  return output;
}
