import { tableExists } from './helpers.js';

// Second sign-in step: each person's passkeys (the phone's fingerprint or face, Windows Hello, a security key)
// and their one-time recovery codes. Only the public key of a passkey is kept; the biometric never leaves the
// device. Recovery codes are stored as SHA-256 hashes.
export default {
  id: '008-dos-pasos',
  descripcion: 'Crea webauthn_credenciales y codigos_recuperacion para la verificación en dos pasos.',
  async check(db) {
    return await tableExists(db, 'users') ? [] : ['no existe la tabla users.'];
  },
  async up(db, { log }) {
    await db.query(`CREATE TABLE IF NOT EXISTS webauthn_credenciales (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      credential_id VARCHAR(512) NOT NULL,
      public_key BLOB NOT NULL,
      counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
      transports VARCHAR(255) NULL,
      nombre VARCHAR(80) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP NULL,
      UNIQUE KEY webauthn_credenciales_credential (credential_id),
      INDEX webauthn_credenciales_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    log('  webauthn_credenciales lista.');
    await db.query(`CREATE TABLE IF NOT EXISTS codigos_recuperacion (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      codigo_hash CHAR(64) NOT NULL,
      used_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY codigos_recuperacion_codigo (user_id, codigo_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    log('  codigos_recuperacion lista.');
  },
};
