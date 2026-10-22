import { telegramIdHash } from '../../src/telegramIdCrypto.js';

const TELEGRAM_TEST_KEY = Buffer.alloc(32, 7).toString('base64');

export const telegramTestConfig = (token) => ({ TELEGRAM_API_TOKEN: token, TELEGRAM_ID_ENCRYPTION_KEY: TELEGRAM_TEST_KEY });

// Simulates the users table lookup that links Telegram IDs to active accounts.
export const withLinkedTelegramUsers = (pool, config, telegramIds) => {
  const hashes = new Set(telegramIds.map((id) => telegramIdHash(id, config)));
  return Object.assign(pool, { execute: async (_sql, [hash]) => [hashes.has(hash) ? [{ id: 1 }] : []] });
};
