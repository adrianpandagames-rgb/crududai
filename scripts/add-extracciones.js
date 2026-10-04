import pool from '../src/db.js';
import { crearTablaExtracciones } from '../src/extraccionesService.js';
try {
  await crearTablaExtracciones(pool);
  console.log('Tabla Extracciones lista.');
} finally { await pool.end(); }
