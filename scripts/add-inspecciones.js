import pool from '../src/db.js';
import { crearTablaInspecciones } from '../src/inspeccionesService.js';
try {
  await crearTablaInspecciones(pool);
  console.log('Tabla Inspecciones lista.');
} finally { await pool.end(); }
