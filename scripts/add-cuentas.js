import pool from '../src/db.js';
import { createCuentaStore } from '../src/cuentaService.js';
import { createNotificacionesStore } from '../src/notificacionesService.js';
try {
  await createCuentaStore(pool).initialize();
  await createNotificacionesStore(pool).initialize();
  console.log('Tablas user_cuentas y notificaciones listas.');
} finally { await pool.end(); }
