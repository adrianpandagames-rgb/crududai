import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(config = process.env) {
  const encoded = config.TELEGRAM_ID_ENCRYPTION_KEY || '';
  let key;
  try { key = Buffer.from(encoded, 'base64'); } catch { key = null; }
  if (!key || key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('TELEGRAM_ID_ENCRYPTION_KEY debe ser una clave Base64 válida de 32 bytes.');
  }
  return key;
}

export function encryptTelegramId(value, config = process.env) {
  const id = String(value);
  const key = getKey(config);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(id, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const hash = crypto.createHmac('sha256', key).update(id).digest('hex');
  return { encrypted: `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`, hash };
}

export function decryptTelegramId(value, config = process.env) {
  if (!value) return '';
  const [version, ivText, tagText, encryptedText] = String(value).split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('Formato de ID de Telegram cifrado inválido.');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(config), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

export function telegramIdHash(value, config = process.env) {
  return crypto.createHmac('sha256', getKey(config)).update(String(value)).digest('hex');
}

