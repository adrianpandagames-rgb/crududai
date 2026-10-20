import 'dotenv/config';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

try {
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
     AND COLUMN_NAME IN ('telegram_id_encrypted', 'telegram_id_hash')`,
  );
  const existing = new Set(columns.map(row => row.COLUMN_NAME));
  if (!existing.has('telegram_id_encrypted')) {
    await connection.query('ALTER TABLE users ADD COLUMN telegram_id_encrypted TEXT NULL');
    console.log('Added users.telegram_id_encrypted.');
  }
  if (!existing.has('telegram_id_hash')) {
    await connection.query('ALTER TABLE users ADD COLUMN telegram_id_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL');
    console.log('Added users.telegram_id_hash.');
  }
  const [indexes] = await connection.query(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
     AND INDEX_NAME = 'uq_users_telegram_id_hash'`,
  );
  if (indexes.length === 0) {
    await connection.query('ALTER TABLE users ADD UNIQUE KEY uq_users_telegram_id_hash (telegram_id_hash)');
    console.log('Added unique index uq_users_telegram_id_hash.');
  }
} finally {
  await connection.end();
}
