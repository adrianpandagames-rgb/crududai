import pool from '../src/db.js';
import { crearTablaDatosConservados } from '../src/datosConservadosService.js';
try {
  await crearTablaDatosConservados(pool);
  console.log('Tabla DatosConservados lista.');
} finally {
  await pool.end();
}
