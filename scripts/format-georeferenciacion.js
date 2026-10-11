import pool from '../src/db.js';
import { initializeGeocodingLocations } from '../src/georeferenciacionUbicaciones.js';
import { formatGeocodingLocation, recoverLegacyAddressDetails } from '../src/georeferenciacionFormato.js';

let updated = 0, pending = 0;
try {
  await initializeGeocodingLocations(pool);
  let lastId = 0;
  while (true) {
    const [rows] = await pool.execute('SELECT * FROM georeferenciacion_ubicaciones WHERE id > ? ORDER BY id LIMIT 500', [lastId]);
    if (!rows.length) break;
    for (const row of rows) {
      lastId = row.id;
      const existing = typeof row.componentes_direccion === 'string' ? JSON.parse(row.componentes_direccion) : row.componentes_direccion;
      const details = existing || recoverLegacyAddressDetails(row.ubicacion);
      if (!details) { pending++; continue; }
      if (!existing) details.originalPlace = row.lugar;
      const result = formatGeocodingLocation({ address: row.ubicacion, place: row.lugar, addressDetails: details,
        betweenStreet1: row.entre_calle_1, betweenStreet2: row.entre_calle_2 });
      if (existing && result.address === row.ubicacion && result.place === row.lugar) continue;
      // Do not overwrite a concurrent update made by the application.
      const [change] = await pool.execute(`UPDATE georeferenciacion_ubicaciones SET ubicacion = ?, lugar = ?, componentes_direccion = ?
        WHERE id = ? AND ubicacion = ? AND lugar = ? AND entre_calle_1 = ? AND entre_calle_2 = ?`,
      [result.address, result.place, JSON.stringify(details), row.id, row.ubicacion, row.lugar, row.entre_calle_1, row.entre_calle_2]);
      updated += change.affectedRows;
    }
  }
  console.log(`Ubicaciones formateadas: ${updated}. Sin componentes suficientes, conservadas: ${pending}. Sin llamadas externas.`);
} catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
finally { await pool.end(); }
