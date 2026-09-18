import 'dotenv/config';
import path from 'path';
import * as XLSXModule from 'xlsx';
import pool from '../src/db.js';

const XLSX = XLSXModule.default || XLSXModule;
const workbookPath = path.resolve('AGEEML_20269101014672.xlsx');
const BATCH_SIZE = 1000;
const formatName = (value) => {
  const text = String(value || '').trim().toLocaleLowerCase('es-MX');
  return text ? `${text.charAt(0).toLocaleUpperCase('es-MX')}${text.slice(1)}` : '';
};

const connection = await pool.getConnection();

try {
  const workbook = XLSX.readFile(workbookPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  await connection.query(`
    CREATE TABLE IF NOT EXISTS localidades_mexico (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      estado VARCHAR(120) NOT NULL,
      localidad VARCHAR(255) NOT NULL,
      UNIQUE KEY localidades_mexico_estado_localidad (estado, localidad),
      INDEX localidades_mexico_estado_index (estado)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  let imported = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const values = rows
      .slice(start, start + BATCH_SIZE)
      .map((row) => [formatName(row.NOM_ENT), formatName(row.NOM_LOC)])
      .filter(([estado, localidad]) => estado && localidad);

    if (values.length === 0) continue;

    await connection.query(
      'INSERT IGNORE INTO localidades_mexico (estado, localidad) VALUES ?',
      [values],
    );
    imported += values.length;
    console.log(`Procesadas ${Math.min(start + BATCH_SIZE, rows.length)} de ${rows.length} filas.`);
  }

  await connection.query(
    `UPDATE localidades_mexico
      SET estado = CONCAT(UPPER(LEFT(LOWER(estado), 1)), SUBSTRING(LOWER(estado), 2)),
          localidad = CONCAT(UPPER(LEFT(LOWER(localidad), 1)), SUBSTRING(LOWER(localidad), 2))`,
  );

  const [[{ total }]] = await connection.query('SELECT COUNT(*) AS total FROM localidades_mexico');
  console.log(`Catálogo importado. Filas procesadas: ${imported}. Localidades únicas en la base: ${total}.`);
} catch (error) {
  console.error(`No fue posible importar localidades: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
