import 'dotenv/config';
import pool from '../src/db.js';

const connection = await pool.getConnection();
try {
  const [columns] = await connection.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`,
  );

  if (columns.length === 0) {
    await connection.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'usuario' AFTER is_admin");
  }

  await connection.execute("UPDATE users SET role = 'admin' WHERE is_admin = 1");
  console.log('User roles enabled: admin, semadmin and usuario.');
} catch (error) {
  console.error(`User-role migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
