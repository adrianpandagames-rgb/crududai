import pool from '../src/db.js';
import { crearTablaViaAlcance } from '../src/viaAlcanceService.js';
try {
  await crearTablaViaAlcance(pool);
  console.log('Tabla ViaAlcance lista.');
} finally { await pool.end(); }
