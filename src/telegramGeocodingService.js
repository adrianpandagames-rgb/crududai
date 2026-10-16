import { processGeocodingFile, reverseGeocode } from './georeferenciacionService.js';
import { initializeGeocodingLocations, findGeocodingLocation, saveGeocodingLocation } from './georeferenciacionUbicaciones.js';
import { initializeLocalRoads, createLocalCrossStreetLookup } from './redVialLocal.js';

export function createCoverageGeocoder(pool, {
  geocode = reverseGeocode,
  initialize = async () => { await initializeGeocodingLocations(pool); await initializeLocalRoads(pool); },
  findLocation = (lat, lng) => findGeocodingLocation(pool, lat, lng),
  saveLocation = (location) => saveGeocodingLocation(pool, location),
  crossStreets = createLocalCrossStreetLookup(pool),
} = {}) {
  let ready;
  const pending = new Map();
  return async (lat, lng) => {
    const key = `${lat.toFixed(9)},${lng.toFixed(9)}`;
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      // Recheck registered antennas before issuing any external geocoding request.
      const [registered] = await pool.query(`SELECT idUbicacion, latitude, longitude, ubicacion, lugar FROM ubicaciones
        WHERE ABS(CAST(latitude AS DECIMAL(10,6)) - ?) < 0.000001
          AND ABS(CAST(longitude AS DECIMAL(10,6)) - ?) < 0.000001 ORDER BY idUbicacion DESC LIMIT 5`, [lat, lng]);
      if (registered.length) return { rows: registered, status: 'REGISTRADA' };
      if (!ready) ready = initialize().catch((error) => { ready = null; throw error; });
      await ready;
      const result = await processGeocodingFile({
        rows: [['latitud', 'longitud'], [String(lat), String(lng)]], delimiter: ',', latitude: 0, longitude: 1,
      }, { geocode, findLocation, crossStreets, onLocation: saveLocation });
      const record = Object.fromEntries(result[0].map((header, index) => [header, result[1][index]]));
      if (record.estado_geocodificacion !== 'OK') return { rows: [], status: record.estado_geocodificacion };
      return { rows: [{ latitude: lat, longitude: lng, ubicacion: record.ubicacion, lugar: record.lugar,
        entre_calle_1: record.entre_calle_1, entre_calle_2: record.entre_calle_2, fuente: 'geocoding' }], status: 'OK' };
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  };
}
