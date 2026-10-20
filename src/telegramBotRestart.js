import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let pendingRestart;

export function restartTelegramBot({ env = process.env, run = execute, logger = console } = {}) {
  if (pendingRestart) return pendingRestart;
  pendingRestart = (async () => {
    const name = env.TELEGRAM_BOT_PM2_NAME || 'crududai-telegram';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || name === 'crududai') {
      throw new Error('Nombre de proceso del bot inválido.');
    }
    await run(env.PM2_EXECUTABLE || 'pm2', ['restart', name, '--update-env'], {
      timeout: 20000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    logger.info('Bot actualizado: reinicio de Telegram confirmado por PM2.');
  })().finally(() => { pendingRestart = undefined; });
  return pendingRestart;
}
