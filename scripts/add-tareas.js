import pool from '../src/db.js';
import { createTareasStore } from '../src/tareasService.js';
try {
  await createTareasStore(pool).initialize();
  console.log('Tabla tareas lista.');
} finally { await pool.end(); }
