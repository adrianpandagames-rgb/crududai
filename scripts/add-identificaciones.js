import pool from '../src/db.js';
import { crearTablaIdentificaciones } from '../src/identificacionesService.js';

try {
  await crearTablaIdentificaciones(pool);
  console.log('Tabla Identificaciones lista.');
} finally {
  await pool.end();
}
