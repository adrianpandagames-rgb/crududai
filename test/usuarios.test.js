import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { listarUsuarios, roleDescriptions, roleLabels, userRoleOf, userRoles } from '../src/usuariosService.js';

const rows = [
  { id: 1, email: 'inicial@example.com', is_admin: 1, role: 'admin', is_active: 1, is_initial_admin: 1, must_change_password: 0, telegram_id_encrypted: 'enc', lastLoginTs: Date.UTC(2026, 9, 24, 1) / 1000 },
  { id: 2, email: "o'brien@example.com", is_admin: 0, role: 'uecs', is_active: 1, is_initial_admin: 0, must_change_password: 1, telegram_id_encrypted: null, lastLoginTs: null },
  { id: 3, email: 'baja@example.com', is_admin: 0, role: 'raro', is_active: 0, is_initial_admin: 0, must_change_password: 1, telegram_id_encrypted: null, lastLoginTs: null },
];
const pool = { query: async () => [rows.map((row) => ({ ...row }))] };

test('lists users with role, last access in Sonora time and counters', async () => {
  const { users, counts } = await listarUsuarios(pool, () => '123456');
  assert.equal(users[0].lastLogin, '2026-10-23 18:00:00');
  assert.equal(users[0].telegramId, '123456');
  assert.equal(users[1].neverLoggedIn, true);
  assert.equal(users[2].role, 'usuario');
  assert.equal('telegram_id_encrypted' in users[0], false);
  assert.deepEqual(counts, { activos: 2, deshabilitados: 1, pendientes: 1, telegram: 1 });
  assert.equal(userRoleOf({ is_admin: '1', role: 'usuario' }), 'admin');
});

const render = async (currentUserId) => {
  const { users, counts } = await listarUsuarios(pool, () => '123456');
  return ejs.renderFile('views/pages/usuarios.ejs', {
    users, counts, roleLabels, roleDescriptions, userRoles, message: null, error: null,
    currentUser: { id: currentUserId, isAdmin: true, role: 'admin' },
  });
};

test('other admins cannot change the initial administrator', async () => {
  const html = await render(2);
  const initialRow = html.split('<tr>').find((row) => row.includes('inicial@example.com'));
  assert.match(initialRow, /<select name="role"[^>]*disabled/);
  assert.match(initialRow, /Solo el administrador inicial puede cambiar su contraseña/);
  assert.match(initialRow, /no puede ser deshabilitado por otro usuario/);
  const ownRow = (await render(1)).split('<tr>').find((row) => row.includes('inicial@example.com'));
  assert.doesNotMatch(ownRow, /<select name="role"[^>]*disabled/);
});

test('e-mails stay out of inline JavaScript and show their status', async () => {
  const html = await render(1);
  assert.doesNotMatch(html, /onsubmit=/);
  assert.match(html, /data-confirm="¿Deshabilitar a o&#39;brien@example.com\?/);
  assert.match(html, /Nunca ha entrado/);
  assert.match(html, /href="\/auditoria\?usuario=o&#39;brien%40example.com"/);
  assert.match(html, /Último acceso/);
  assert.doesNotMatch(html, /Google Geocoding/);
});
