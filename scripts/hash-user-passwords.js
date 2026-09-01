import 'dotenv/config';
import pool from '../src/db.js';
import { hashPassword, isBcryptHash } from '../src/passwordUtils.js';

const connection = await pool.getConnection();

try {
  await connection.beginTransaction();

  const [columns] = await connection.execute(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'password'`
  );

  if (columns.length === 0) {
    throw new Error("The users.password column does not exist in the selected database.");
  }

  const maxLength = columns[0].maxLength;
  if (maxLength !== null && maxLength < 60) {
    await connection.query('ALTER TABLE users MODIFY password VARCHAR(255) NOT NULL');
  }

  const [users] = await connection.query('SELECT id, password FROM users FOR UPDATE');
  let migrated = 0;

  for (const user of users) {
    if (isBcryptHash(user.password)) continue;
    if (typeof user.password !== 'string' || user.password.length === 0) {
      throw new Error(`User ${user.id} has an empty or invalid password and was not changed.`);
    }

    await connection.execute('UPDATE users SET password = ? WHERE id = ?', [await hashPassword(user.password), user.id]);
    migrated += 1;
  }

  await connection.commit();
  console.log(`Password migration complete. Hashed ${migrated} user password(s).`);
} catch (error) {
  await connection.rollback();
  console.error('Password migration failed; no changes were committed.');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
