import pool from '../src/db.js';

try {
  const [columns] = await pool.query("SHOW COLUMNS FROM objetivo LIKE 'delito'");
  if (columns.length === 0) {
    await pool.query('ALTER TABLE objetivo ADD COLUMN delito VARCHAR(255) NULL DEFAULT NULL');
    console.log('Campo delito agregado a objetivo.');
  } else {
    console.log('El campo delito ya existe; no se realizaron cambios.');
  }
} catch (error) {
  console.error('No fue posible agregar delito:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
