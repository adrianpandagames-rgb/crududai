import { formatAuditTimestamp } from './auditFilters.js';

export const userRoles = ['usuario', 'uecs', 'semiadmin', 'admin'];

export const roleLabels = {
  usuario: 'Usuario', uecs: 'UECS', semiadmin: 'Semiadministrador', admin: 'Administrador',
};

export const roleDescriptions = {
  usuario: 'Consulta y registra en Líneas, IMEI, Ubicaciones y Métricas. No puede editar registros existentes.',
  uecs: 'Solo busca y consulta Líneas, IMEI y Ubicaciones; además usa Georreferenciación, Planeación, Ruta y las herramientas de búsqueda. En Perfiles registra y agrega fotos, sin editar ni eliminar. No ve Métricas.',
  semiadmin: 'Igual que Usuario y además puede editar registros existentes.',
  admin: 'Acceso completo, incluidos Usuarios, Auditoría, Medidores y Red telefónica.',
};

// The job title decides which slot of a task a person can fill; it is independent of the role.
export const userPuestos = ['licenciado', 'ingeniero'];
export const puestoLabels = { licenciado: 'Licenciado', ingeniero: 'Ingeniero' };

// Adds users.puesto the first time it is needed, so a deploy works before the migration script runs.
const puestoColumns = new WeakMap();
export function ensureUserPuesto(pool) {
  if (!puestoColumns.has(pool)) {
    puestoColumns.set(pool, (async () => {
      const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'puesto'");
      if (!columns.length) await pool.query('ALTER TABLE users ADD COLUMN puesto VARCHAR(20) NULL');
    })().catch((error) => { puestoColumns.delete(pool); throw error; }));
  }
  return puestoColumns.get(pool);
}

export const userRoleOf = (user) => (Number(user.is_admin) === 1 ? 'admin' : (userRoles.includes(user.role) ? user.role : 'usuario'));

// Telegram entries in the audit log have no e-mail, so the last web login is the last access.
export async function listarUsuarios(pool, decryptTelegramId) {
  await ensureUserPuesto(pool);
  const [rows] = await pool.query(`
    SELECT u.id, u.email, u.is_admin, u.role, u.is_active, u.is_initial_admin, u.must_change_password, u.puesto,
           u.telegram_id_encrypted,
           (SELECT UNIX_TIMESTAMP(MAX(a.created_at)) FROM audit_logs a
             WHERE a.user_email = u.email AND a.method = 'LOGIN') AS lastLoginTs
    FROM users u
    ORDER BY u.email ASC
  `);
  const users = rows.map(({ telegram_id_encrypted: encrypted, lastLoginTs, ...user }) => {
    const lastLogin = formatAuditTimestamp(lastLoginTs);
    return {
      ...user,
      role: userRoleOf(user),
      puesto: userPuestos.includes(user.puesto) ? user.puesto : '',
      isActive: Number(user.is_active) === 1,
      isInitialAdmin: Number(user.is_initial_admin) === 1,
      mustChangePassword: Number(user.must_change_password) === 1,
      telegramId: encrypted ? decryptTelegramId(encrypted) : '',
      lastLogin,
      neverLoggedIn: !lastLogin,
    };
  });
  return {
    users,
    counts: {
      activos: users.filter((user) => user.isActive).length,
      deshabilitados: users.filter((user) => !user.isActive).length,
      pendientes: users.filter((user) => user.isActive && user.mustChangePassword).length,
      telegram: users.filter((user) => user.telegramId).length,
    },
  };
}
