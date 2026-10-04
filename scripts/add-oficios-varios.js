import pool from '../src/db.js';
import { crearTablaOficiosVarios } from '../src/oficiosVariosService.js';
try {
  await crearTablaOficiosVarios(pool);
  console.log('Tabla OficiosVarios lista.');
} finally { await pool.end(); }
