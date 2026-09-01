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
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_initial_admin'`,
  );

  if (columns.length === 0) {
    await connection.query('ALTER TABLE users ADD COLUMN is_initial_admin TINYINT(1) NOT NULL DEFAULT 0');
  }

  const [initialAdmins] = await connection.query('SELECT id FROM users WHERE is_initial_admin = 1 LIMIT 1');
  if (initialAdmins.length === 0) {
    const [admins] = await connection.query('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1');
    if (admins.length === 1) {
      await connection.execute('UPDATE users SET is_initial_admin = 1 WHERE id = ?', [admins[0].id]);
      console.log('Marked the initial administrator account.');
    } else {
      console.log('No administrator account found to mark.');
    }
  } else {
    console.log('An initial administrator account is already marked.');
  }
} finally {
  await connection.end();
}
