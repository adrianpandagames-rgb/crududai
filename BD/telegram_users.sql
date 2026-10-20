-- Ejecutar una sola vez en la base de datos de producción.
ALTER TABLE users
  ADD COLUMN telegram_id_encrypted TEXT NULL,
  ADD COLUMN telegram_id_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_users_telegram_id_hash (telegram_id_hash);
