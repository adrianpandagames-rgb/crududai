import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserNotifier } from '../src/userNotifications.js';

const env = { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'avisos@example.com', SMTP_USER: 'user', SMTP_PASSWORD: 'smtp-secret' };

test('each account event sends an individual notification without SMTP credentials', async () => {
  const mails = [];
  let options;
  const notify = createUserNotifier({ env, createTransport(config) {
    options = config;
    return { async sendMail(mail) { mails.push(mail); return { accepted: ['user@example.com'] }; } };
  } });
  for (const event of ['created', 'reset', 'changed']) {
    assert.equal((await notify('user@example.com', event, { temporaryPassword: 'temporary-test-password' })).sent, true);
  }
  assert.equal(options.requireTLS, true);
  assert.equal(options.port, 587);
  assert.equal(new Set(mails.map(mail => mail.subject)).size, 3);
  assert.match(mails[0].text, /Contraseña temporal: temporary-test-password/);
  assert.match(mails[0].text, /cámbiala al iniciar sesión/);
  assert.match(mails[1].text, /Contraseña temporal: temporary-test-password/);
  assert.match(mails[1].text, /cámbiala al iniciar sesión/);
  assert.equal(mails[2].text.includes('temporary-test-password'), false);
  for (const mail of mails) {
    assert.deepEqual(mail.to, { address: 'user@example.com' });
    assert.equal(JSON.stringify(mail).includes('smtp-secret'), false);
  }
});

test('creation and reset without a temporary password do not send mail', async () => {
  const notify = createUserNotifier({ env, logger: { error() {} }, createTransport() { assert.fail('Unexpected transport'); } });
  assert.equal((await notify('user@example.com', 'created')).sent, false);
  assert.equal((await notify('user@example.com', 'reset')).sent, false);
});

test('missing SMTP settings reports a warning without creating a transport', async () => {
  const notify = createUserNotifier({ env: {}, createTransport() { assert.fail('Unexpected transport'); } });
  const result = await notify('user@example.com', 'created', { temporaryPassword: 'temporary-test-password' });
  assert.equal(result.sent, false);
  assert.match(result.warning, /falta configurar SMTP/);
});

test('SMTP errors and rejected recipients report failure without leaking error details', async () => {
  for (const sendMail of [async () => { throw new Error('smtp-secret'); }, async () => ({ accepted: [], rejected: ['user@example.com'] })]) {
    const logs = [];
    const notify = createUserNotifier({ env, createTransport: () => ({ sendMail }), logger: { error: message => logs.push(message) } });
    const result = await notify('user@example.com', 'changed');
    assert.equal(result.sent, false);
    assert.equal(JSON.stringify([logs, result]).includes('smtp-secret'), false);
  }
});
