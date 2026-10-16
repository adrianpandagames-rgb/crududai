import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../src/db.js';
import { normalizeStoredCity } from '../src/locationText.js';

const apply = process.argv.includes('--apply');
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  const [rows] = await connection.query('SELECT idUbicacion, lugar FROM ubicaciones FOR UPDATE');
  const changes = rows.map(row => ({ ...row, normalized: normalizeStoredCity(row.lugar) }))
    .filter(row => row.lugar !== row.normalized);
  console.log(JSON.stringify({ total: rows.length, changes: changes.length, examples: changes.slice(0, 10) }, null, 2));
  if (apply && changes.length) {
    const directory = path.resolve('backups');
    fs.mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, `ubicaciones-ciudades-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify(changes.map(({ idUbicacion, lugar }) => ({ idUbicacion, lugar })), null, 2), { flag: 'wx' });
    console.log(`Respaldo: ${backup}`);
    for (const row of changes) {
      await connection.execute('UPDATE ubicaciones SET lugar = ? WHERE idUbicacion = ?', [row.normalized, row.idUbicacion]);
    }
    const [verified] = await connection.query('SELECT lugar FROM ubicaciones');
    if (verified.some(row => row.lugar !== normalizeStoredCity(row.lugar))) throw new Error('La verificación de normalización falló');
  }
  if (apply) await connection.commit();
  else await connection.rollback();
  console.log(apply ? 'Normalización completada y verificada.' : 'Vista previa; no se modificaron registros.');
} catch (error) {
  await connection.rollback();
  console.error(error.message);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
