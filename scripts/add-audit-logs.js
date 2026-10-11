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
  await connection.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      user_email VARCHAR(255) NOT NULL,
      method VARCHAR(20) NOT NULL,
      request_path VARCHAR(255) NOT NULL,
      status_code SMALLINT UNSIGNED NOT NULL,
      ip_address VARCHAR(45) NULL,
      details LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX audit_logs_created_at_index (created_at),
      INDEX audit_logs_user_id_index (user_id)
    )
  `);

  await connection.query('ALTER TABLE audit_logs MODIFY user_id INT NULL');
  await connection.query('ALTER TABLE audit_logs MODIFY method VARCHAR(20) NOT NULL');
  const [columns] = await connection.query("SHOW COLUMNS FROM audit_logs LIKE 'details'");
  if (columns.length === 0) {
    await connection.query('ALTER TABLE audit_logs ADD COLUMN details LONGTEXT NULL');
  }
  console.log('Audit log table is ready.');
} finally {
  await connection.end();
}
