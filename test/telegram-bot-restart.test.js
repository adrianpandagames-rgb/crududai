import test from 'node:test';
import assert from 'node:assert/strict';
import { restartTelegramBot } from '../src/telegramBotRestart.js';

test('reinicia solamente el bot y espera la confirmación de PM2', async () => {
  const calls = [];
  await restartTelegramBot({ env: {}, run: async (...args) => calls.push(args), logger: { info() {} } });
  assert.equal(calls[0][0], 'pm2');
  assert.deepEqual(calls[0][1], ['restart', 'crududai-bot', '--update-env']);
  assert.equal(calls[0][2].timeout, 20000);
});

test('propaga fallos y permite reintentar sin anunciar éxito', async () => {
  let announced = false;
  await assert.rejects(restartTelegramBot({ env: {}, run: async () => { throw new Error('offline'); }, logger: { info() { announced = true; } } }), /offline/);
  assert.equal(announced, false);
  await restartTelegramBot({ env: {}, run: async () => {}, logger: { info() {} } });
});

test('impide reiniciar la aplicación web o pasar opciones como nombre', async () => {
  for (const name of ['crududai', '--all', 'bot; reboot']) {
    await assert.rejects(restartTelegramBot({ env: { TELEGRAM_BOT_PM2_NAME: name }, run: async () => assert.fail('No debe ejecutar PM2') }), /inválido/);
  }
});

test('agrupa reinicios simultáneos', async () => {
  let finish;
  let calls = 0;
  const options = { env: {}, run: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, logger: { info() {} } };
  const first = restartTelegramBot(options);
  const second = restartTelegramBot(options);
  assert.equal(first, second);
  finish();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
