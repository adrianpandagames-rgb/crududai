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
    CREATE TABLE IF NOT EXISTS ruta_archivos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      file_uuid CHAR(36) NOT NULL UNIQUE,
      line_number VARCHAR(50) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL,
      result_csv LONGTEXT NULL,
      source_file LONGBLOB NULL,
      heatmap_png LONGBLOB NULL,
      row_count INT UNSIGNED NOT NULL DEFAULT 0,
      error_message VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      INDEX ruta_archivos_expires_at_index (expires_at)
    )
  `);
  console.log('Ruta file table is ready.');
} finally {
  await connection.end();
}