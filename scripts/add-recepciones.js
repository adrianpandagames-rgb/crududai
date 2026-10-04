import pool from '../src/db.js';
import { crearTablaRecepciones } from '../src/recepcionesService.js';
try {
  await crearTablaRecepciones(pool);
  console.log('Tabla Recepciones lista.');
} finally { await pool.end(); }
