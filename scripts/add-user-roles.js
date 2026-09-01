import 'dotenv/config';
import pool from '../src/db.js';

const adminEmail = String(process.argv[2] || '').trim().toLowerCase();
if (!adminEmail) {
  console.error('Usage: npm run migrate:user-roles -- admin@example.com');
  process.exit(1);
}

const connection = await pool.getConnection();
try {
  const [columns] = await connection.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_admin'`
  );
  if (columns.length === 0) {
    await connection.query('ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0');
  }

  const [result] = await connection.execute('UPDATE users SET is_admin = 1 WHERE LOWER(email) = ?', [adminEmail]);
  if (result.affectedRows !== 1) {
    throw new Error(`No user was found for ${adminEmail}. No administrator was assigned.`);
  }

  console.log(`User roles enabled. ${adminEmail} is an administrator.`);
} catch (error) {
  console.error(`User-role migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
