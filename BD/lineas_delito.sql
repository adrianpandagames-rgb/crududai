-- Ejecutar una sola vez, seleccionando la base de datos de la aplicación.
ALTER TABLE objetivo ADD COLUMN delito VARCHAR(255) NULL DEFAULT NULL;
