import pool from '../src/db.js';
import { crearTablaCarpetasResguardo, agregarColumnaCarpetaResguardo } from '../src/carpetasResguardoService.js';
try {
  await crearTablaCarpetasResguardo(pool);
  await agregarColumnaCarpetaResguardo(pool);
  console.log('Tabla CarpetasResguardo y columna carpeta_resguardo listas.');
} finally { await pool.end(); }
