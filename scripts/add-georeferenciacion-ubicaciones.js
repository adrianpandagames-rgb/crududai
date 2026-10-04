import pool from '../src/db.js';
import { initializeGeocodingLocations } from '../src/georeferenciacionUbicaciones.js';

try {
  await initializeGeocodingLocations(pool);
  console.log('Tabla georeferenciacion_ubicaciones creada/verificada.');
} catch (error) {
  console.error('No fue posible crear la tabla:', error.code || 'Error de base de datos');
  process.exitCode = 1;
} finally {
  await pool.end();
}
