import crypto from 'node:crypto';

// Second sign-in step with passkeys (WebAuthn): the phone asks for the fingerprint or face, a PC for Windows
// Hello or a security key. The browser only allows it on the site's own domain over HTTPS, never on an IP.
// An account has the second step on while it keeps at least one passkey; the recovery codes go with them.

export const MAX_PASSKEYS = 10;
export const CODIGOS_POR_JUEGO = 10;
export const MAX_NOMBRE_PASSKEY = 80;
// No 0/O or 1/I, so a code copied by hand is read the same. 32 symbols × 10 characters = 50 bits each.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO_CODIGO = 10;

// Where passkeys are valid: WEBAUTHN_ORIGIN, or else PUBLIC_BASE_URL (the system's public address). On a
// developer's machine it falls back to https://localhost. Returns null when no usable domain is set, and then
// nobody can add a passkey (people who already have one still finish with a recovery code).
export function configWebauthn(env = process.env) {
  const base = env.WEBAUTHN_ORIGIN || env.PUBLIC_BASE_URL;
  let origin = null;
  try {
    origin = base ? new URL(base).origin : null;
  } catch {
    origin = null;
  }
  if (!origin && env.NODE_ENV !== 'production') origin = `https://localhost:${env.HTTPS_PORT || 3443}`;
  if (!origin) return null;
  const { protocol, hostname } = new URL(origin);
  if (protocol !== 'https:' && hostname !== 'localhost') return null;
  const rpID = String(env.WEBAUTHN_RP_ID || hostname).toLowerCase();
  // WebAuthn refuses IP addresses; the domain must be the page's own or one it belongs to.
  if (/^[\d.]+$/.test(rpID) || rpID.includes(':') || !(hostname === rpID || hostname.endsWith(`.${rpID}`))) return null;
  return { origin, rpID, rpName: env.WEBAUTHN_RP_NAME || 'CRUDUDAI' };
}

export function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i += 1) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
}

// Accepts the code as written, with or without the dash, in either case. Returns null when it cannot be one.
export function normalizarCodigo(valor) {
  const limpio = String(valor ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (limpio.length !== LARGO_CODIGO || [...limpio].some((c) => !ALFABETO.includes(c))) return null;
  return limpio;
}

const hashCodigo = (normalizado) => crypto.createHash('sha256').update(normalizado).digest('hex');

export function nombrePasskey(valor) {
  const nombre = String(valor ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOMBRE_PASSKEY);
  return nombre || 'Dispositivo';
}

// Before the migration runs the tables do not exist; that only means nobody has the second step yet.
const sinTabla = (error) => error?.code === 'ER_NO_SUCH_TABLE';
const tolerarSinTabla = (vacio) => (error) => {
  if (sinTabla(error)) return vacio;
  throw error;
};

export function createDosPasosStore(pool) {
  return {
    async activo(userId) {
      return pool.execute('SELECT 1 FROM webauthn_credenciales WHERE user_id = ? LIMIT 1', [userId])
        .then(([rows]) => rows.length > 0, tolerarSinTabla(false));
    },

    async usuariosConDosPasos() {
      return pool.query('SELECT DISTINCT user_id FROM webauthn_credenciales')
        .then(([rows]) => new Set(rows.map((row) => Number(row.user_id))), tolerarSinTabla(new Set()));
    },

    async listar(userId) {
      return pool.execute(
        `SELECT id, nombre, created_at AS creada, last_used_at AS usada FROM webauthn_credenciales
         WHERE user_id = ? ORDER BY created_at, id`,
        [userId],
      ).then(([rows]) => rows, tolerarSinTabla([]));
    },

    async credenciales(userId) {
      const [rows] = await pool.execute(
        'SELECT credential_id, public_key, counter, transports FROM webauthn_credenciales WHERE user_id = ?',
        [userId],
      );
      return rows.map((row) => ({
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: Number(row.counter),
        transports: row.transports ? row.transports.split(',') : undefined,
      }));
    },

    async guardar(userId, { id, publicKey, counter, transports, nombre }) {
      await pool.execute(
        `INSERT INTO webauthn_credenciales (user_id, credential_id, public_key, counter, transports, nombre)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, id, Buffer.from(publicKey), counter || 0, transports?.length ? transports.join(',') : null, nombrePasskey(nombre)],
      );
    },

    async registrarUso(userId, credentialId, counter) {
      await pool.execute(
        'UPDATE webauthn_credenciales SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND credential_id = ?',
        [counter, userId, credentialId],
      );
    },

    // Removing the last passkey turns the second step off, so its recovery codes go too.
    async eliminar(userId, id) {
      const [result] = await pool.execute('DELETE FROM webauthn_credenciales WHERE id = ? AND user_id = ?', [id, userId]);
      if (result.affectedRows !== 1) return { eliminada: false };
      const quedan = await this.activo(userId);
      if (!quedan) await pool.execute('DELETE FROM codigos_recuperacion WHERE user_id = ?', [userId]);
      return { eliminada: true, quedan };
    },

    async eliminarTodo(userId) {
      const [result] = await pool.execute('DELETE FROM webauthn_credenciales WHERE user_id = ?', [userId]);
      await pool.execute('DELETE FROM codigos_recuperacion WHERE user_id = ?', [userId]);
      return result.affectedRows;
    },

    // A new set replaces the old one. The codes are returned once, to be shown; only their hashes are kept.
    async nuevosCodigos(userId) {
      const codigos = Array.from({ length: CODIGOS_POR_JUEGO }, generarCodigo);
      await pool.execute('DELETE FROM codigos_recuperacion WHERE user_id = ?', [userId]);
      await pool.query(
        'INSERT INTO codigos_recuperacion (user_id, codigo_hash) VALUES ?',
        [codigos.map((codigo) => [userId, hashCodigo(normalizarCodigo(codigo))])],
      );
      return codigos;
    },

    async codigosRestantes(userId) {
      return pool.execute('SELECT COUNT(*) AS n FROM codigos_recuperacion WHERE user_id = ? AND used_at IS NULL', [userId])
        .then(([[row]]) => Number(row.n), tolerarSinTabla(0));
    },

    // Each code works once: marking it used is the check, so two requests with the same code cannot both pass.
    async usarCodigo(userId, valor) {
      const normalizado = normalizarCodigo(valor);
      if (!normalizado) return false;
      const [result] = await pool.execute(
        'UPDATE codigos_recuperacion SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND codigo_hash = ? AND used_at IS NULL',
        [userId, hashCodigo(normalizado)],
      );
      return result.affectedRows === 1;
    },
  };
}

// Sign-ins that passed the password and wait for the second step. They live in memory, like the sessions,
// for five minutes and five attempts; the cookie that names one only reaches /verificar.
export const PENDIENTE_COOKIE = 'auth2fa';
export const PENDIENTE_MS = 5 * 60 * 1000;
export const MAX_INTENTOS_PENDIENTE = 5;

export function createPendientes({ ttlMs = PENDIENTE_MS, now = () => Date.now() } = {}) {
  const pendientes = new Map();
  const vigente = (token) => {
    const pendiente = pendientes.get(token);
    if (!pendiente) return null;
    if (now() - pendiente.creado > ttlMs) {
      pendientes.delete(token);
      return null;
    }
    return pendiente;
  };
  return {
    crear(datos) {
      const token = crypto.randomBytes(24).toString('hex');
      pendientes.set(token, { ...datos, creado: now(), intentos: 0, challenge: null });
      return token;
    },
    obtener: (token) => (token ? vigente(token) : null),
    quitar: (token) => pendientes.delete(token),
    podar() {
      for (const token of pendientes.keys()) vigente(token);
    },
  };
}

export const opcionesCookiePendiente = () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/verificar', maxAge: PENDIENTE_MS });
