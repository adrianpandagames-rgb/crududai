import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGeocodingLocation, recoverLegacyAddressDetails } from '../src/georeferenciacionFormato.js';
import { reverseGeocode, readGeocodingFile, processGeocodingFile } from '../src/georeferenciacionService.js';
import { findGeocodingLocation } from '../src/georeferenciacionUbicaciones.js';

const details = { street: 'Calle Juárez', neighborhood: 'Centro', postalCode: '83000', city: 'Hermosillo', state: 'Sonora' };
test('formats location and city/state separately, omitting unavailable components', () => {
  const result = formatGeocodingLocation({ addressDetails: details, betweenStreet1: 'Hidalgo', betweenStreet2: 'Morelos' });
  assert.equal(result.address, 'Calle Juárez, entre Hidalgo y Morelos, Centro, C.P. 83000');
  assert.equal(result.place, 'Hermosillo, Sonora');
  assert.equal(formatGeocodingLocation({ addressDetails: { street: 'Juárez' }, betweenStreet1: 'Hidalgo' }).address, 'Juárez');
  assert.equal(formatGeocodingLocation({ street: 'Calle principal' }).address, 'Calle principal');
  assert.equal(formatGeocodingLocation({ address: 'Dirección guardada', betweenStreet1: 'Hidalgo', betweenStreet2: 'Morelos' }).address, 'Dirección guardada');
  assert.equal(formatGeocodingLocation({ addressDetails: { state: 'Sonora' }, address: 'Referencia rural' }).address, 'Referencia rural');
});

test('formats every distinct coordinate using only its available address components', async () => {
  const input = readGeocodingFile(Buffer.from([
    'latitud,longitud',
    '31.331066667,-110.966919444',
    '31.330827778,-110.954869444',
    '31.331791667,-110.944255556',
  ].join('\n')), '.csv');
  const saved = [];
  const rows = await processGeocodingFile(input, {
    geocode: async (latitude) => ({
      street: 'Calle principal',
      addressDetails: latitude === 31.331066667
        ? { street: 'Calle principal', neighborhood: 'Centro', postalCode: '84000' }
        : latitude === 31.330827778
          ? { street: 'Calle principal' }
          : { street: 'Calle principal', neighborhood: 'Colonia Norte' },
      address: 'Dirección original de Google',
      place: 'Nogales',
      status: 'OK',
    }),
    crossStreets: async (_latitude, _longitude, { street }) => {
      assert.equal(street, 'Calle principal');
      return { betweenStreet1: 'Calle X', betweenStreet2: 'Calle Y', crossStreetStatus: 'ENCONTRADAS' };
    },
    onLocation: async (location) => saved.push(location),
  });
  const addressIndex = rows[0].indexOf('ubicacion');
  assert.deepEqual(rows.slice(1).map((row) => row[addressIndex]), [
    'Calle principal, entre Calle X y Calle Y, Centro, C.P. 84000',
    'Calle principal, entre Calle X y Calle Y',
    'Calle principal, entre Calle X y Calle Y, Colonia Norte',
  ]);
  assert.equal(saved.length, 3);
});

test('Google components populate street, neighborhood, postal code, city and state by type', async () => {
  const components = [['street_number', '123'], ['postal_code', '83000'], ['route', 'Calle Juárez'],
    ['sublocality_level_1', 'Centro'], ['locality', 'Hermosillo'], ['administrative_area_level_1', 'Sonora']];
  const result = await reverseGeocode(29, -110, { apiKey: 'test', fetchImpl: async () => ({ ok: true,
    json: async () => ({ status: 'OK', results: [{ formatted_address: 'Original de Google',
      address_components: components.map(([type, long_name]) => ({ long_name, types: [type] })) }] }) }) });
  assert.deepEqual(result.addressDetails, { ...details, originalAddress: 'Original de Google' });
});

test('saved and exported location share the required format and reuse persisted components', async () => {
  const input = readGeocodingFile(Buffer.from('lat,lon\n29,-110\n29,-110'), '.csv');
  const stored = [];
  const options = {
    geocode: async () => ({ address: 'Original', place: 'Hermosillo', street: details.street, addressDetails: details, status: 'OK' }),
    crossStreets: async () => ({ betweenStreet1: 'Hidalgo', betweenStreet2: 'Morelos', crossStreetStatus: 'ENCONTRADAS' }),
    onLocation: async (location) => stored.push(location),
  };
  const rows = await processGeocodingFile(input, options);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].ubicacion, 'Calle Juárez, entre Hidalgo y Morelos, Centro, C.P. 83000');
  assert.equal(stored[0].lugar, 'Hermosillo, Sonora');
  assert.equal(rows[1][rows[0].indexOf('ubicacion')], stored[0].ubicacion);
  const saved = await findGeocodingLocation({ execute: async () => [[{ ...stored[0], componentes_direccion: JSON.stringify(details) }]] }, 29, -110);
  const cached = await processGeocodingFile(input, { findLocation: async () => saved,
    geocode: async () => assert.fail('Must reuse database'), crossStreets: async () => assert.fail('Must reuse entrecalles') });
  assert.equal(cached[1][cached[0].indexOf('ubicacion')], stored[0].ubicacion);
});

test('legacy recovery is conservative and supports Sonora postal addresses without new API calls', () => {
  assert.deepEqual(recoverLegacyAddressDetails('Juárez 123, Centro, 83000 Hermosillo, Son., México'), {
    street: 'Juárez', neighborhood: 'Centro', postalCode: '83000', city: 'Hermosillo', state: 'Sonora',
    originalAddress: 'Juárez 123, Centro, 83000 Hermosillo, Son., México',
  });
  assert.equal(recoverLegacyAddressDetails('Dirección incompleta'), null);
  assert.equal(recoverLegacyAddressDetails('ABCD+EF, 83000 Hermosillo, Son., México'), null);
});
