import pool from '../src/db.js';

try {
  const [columns] = await pool.query("SHOW COLUMNS FROM contactos LIKE 'contacto'");
  if (columns[0]?.Type.toLowerCase() === 'bigint') {
    await pool.query('ALTER TABLE contactos MODIFY COLUMN contacto VARCHAR(32) NOT NULL');
    console.log('La columna contacto ahora admite números y sin utilidad.');
  } else if (!/^varchar\(/i.test(columns[0]?.Type || '')) {
    throw new Error('Tipo de columna contacto inesperado; no se modificó.');
  } else {
    console.log('La columna contacto ya admite texto.');
  }
} finally {
  await pool.end();
}
