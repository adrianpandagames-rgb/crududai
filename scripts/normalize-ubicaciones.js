import 'dotenv/config';
import pool from '../src/db.js';

const normalizeLocationText = (value) => {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  const text = String(value).trim();
  return text === '' || text.endsWith('.') ? text : `${text}.`;
};

const connection = await pool.getConnection();
let updated = 0;

try {
  await connection.beginTransaction();
  const [rows] = await connection.query('SELECT idUbicacion, ubicacion, lugar FROM ubicaciones FOR UPDATE');

  for (const row of rows) {
    const ubicacion = normalizeLocationText(row.ubicacion);
    const lugar = normalizeLocationText(row.lugar);

    if (ubicacion === row.ubicacion && lugar === row.lugar) {
      continue;
    }

    await connection.execute(
      'UPDATE ubicaciones SET ubicacion = ?, lugar = ? WHERE idUbicacion = ?',
      [ubicacion, lugar, row.idUbicacion],
    );
    updated += 1;
  }

  await connection.commit();
  console.log(`Normalización completada. Registros actualizados: ${updated}.`);
} catch (error) {
  await connection.rollback();
  console.error(`No fue posible normalizar ubicaciones: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
