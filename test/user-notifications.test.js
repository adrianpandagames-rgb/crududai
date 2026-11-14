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

test('e-mails go as formatted HTML with the same content in plain text, and escape what they show', async () => {
  const { buildEmail } = await import('../src/userNotifications.js');
  const codigo = buildEmail('codigo', 'ana@example.com', { codigo: '482913', minutos: 10, ip: '203.0.113.7' },
    { now: new Date(Date.UTC(2026, 10, 14, 19)), withLogo: true });
  assert.match(codigo.html, /482913/);
  assert.match(codigo.html, /cid:logo@udai/);
  assert.match(codigo.text, /Código: 482913/);
  assert.match(codigo.text, /Dirección IP: 203\.0\.113\.7/);
  assert.match(codigo.text, /14 de noviembre de 2026.*12:00/);
  assert.match(codigo.text, /cambia tu contraseña/);
  const creada = buildEmail('created', 'x"<b>@example.com', { temporaryPassword: '<script>' }, { baseUrl: 'https://app.example.mx' });
  assert.ok(!creada.html.includes('<script>'));
  assert.ok(!creada.html.includes('x"<b>'));
  assert.match(creada.html, /href="https:\/\/app\.example\.mx\/"/);
  assert.ok(!buildEmail('created', 'a@example.com', { temporaryPassword: 'x' }, { baseUrl: 'javascript:alert(1)' }).html.includes('javascript:'));
});

test('the sign-in code e-mail needs its code', async () => {
  const notify = createUserNotifier({ env, logger: { error() {} }, createTransport() { assert.fail('Unexpected transport'); } });
  assert.equal((await notify('user@example.com', 'codigo', { minutos: 10 })).sent, false);
});
