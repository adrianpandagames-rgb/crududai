import bcrypt from 'bcrypt';

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const DEFAULT_BCRYPT_ROUNDS = 12;

const configuredRounds = Number.parseInt(process.env.BCRYPT_ROUNDS, 10);
export const BCRYPT_ROUNDS = Number.isInteger(configuredRounds) && configuredRounds >= 10 && configuredRounds <= 15
  ? configuredRounds
  : DEFAULT_BCRYPT_ROUNDS;

export const isBcryptHash = (value) => typeof value === 'string' && BCRYPT_HASH_PATTERN.test(value);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

export const verifyPassword = (password, passwordHash) => {
  if (!isBcryptHash(passwordHash)) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
};
