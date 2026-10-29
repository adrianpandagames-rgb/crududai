import "dotenv/config";
import { notifyUser } from './src/userNotifications.js';
import { restartTelegramBot } from './src/telegramBotRestart.js';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import mysql from 'mysql2/promise';
import express from "express";
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import router from "./src/router.js"; // Importa el enrutador
import pool from "./src/db.js";
import { buildAuditFilters, auditActionLabels, auditFilterQuery, auditOrigins, auditResults } from './src/auditFilters.js';
import { auditResources } from './src/auditActions.js';
import { consultarAuditoria, exportarAuditoriaCsv, AUDIT_EXPORT_LIMIT } from './src/auditService.js';
import { buildSessionCookieOptions, isSessionExpired, SESSION_TIMEOUT_MS } from './src/sessionUtils.js';
import { startImeiMetadataDailyJob } from './src/imeiMetadataService.js';
import { hashPassword, verifyPassword } from './src/passwordUtils.js';
import { sanitizeAuditData } from './src/auditDetails.js';
import { auditActivity } from './src/auditMiddleware.js';
import { requireSameOrigin } from './src/requestSecurity.js';
import { createTelegramApiRouter } from './src/telegramApiRouter.js';
import { decryptTelegramId, encryptTelegramId, telegramIdHash } from './src/telegramIdCrypto.js';
import { createPlaneacionRouter } from './src/planeacionRouter.js';
import { createCoincidenciasRouter } from './src/coincidenciasRouter.js';
import { createRedTelefonicaRouter } from './src/redTelefonicaRouter.js';
import { createMaigretRouter, createMaigretSearches } from './src/maigretRouter.js';
import { createImagenesRouter, createPublicImageRouter } from './src/imagenesRouter.js';
import { createNombresRouter } from './src/nombresRouter.js';
import { createPerfilesRouter } from './src/perfilesRouter.js';
import { createTareasRouter } from './src/tareasRouter.js';
import { obtenerMedidores } from './src/medidoresService.js';
import { resetGoogleGeocodingQuota } from './src/googleGeocodingQuota.js';
import { listarUsuarios, roleDescriptions, roleLabels, userRoleOf, userRoles } from './src/usuariosService.js';
import { createLoginRateLimiter, LOGIN_WINDOW_MS } from './src/loginRateLimit.js';
import { forwardAsyncErrors, handleErrors } from './src/errorHandling.js';


const app = forwardAsyncErrors(express());
// Trust only hosting proxies that replace forwarded headers.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean));
}

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CRUDUDAI API',
      version: '1.0.0',
      description: 'API documentation for CRUDUDAI',
    },
    servers: [
      { url: '/' },
    ],
  },
  apis: ['./app.js', './src/*Routes.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 50000 }));
app.use("/public", express.static(fileURLToPath(new URL('./public/', import.meta.url))));

const sessions = new Map();
const pendingRouteToasts = new Map();
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const loginRateLimiter = createLoginRateLimiter();
setInterval(() => loginRateLimiter.prune(), LOGIN_WINDOW_MS).unref();

const writeAuditLog = ({ userId = null, userEmail = '', action, requestPath, statusCode, ipAddress, details = null }) => {
  pool.execute(
    `INSERT INTO audit_logs (user_id, user_email, method, request_path, status_code, ip_address, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, userEmail, action, requestPath, statusCode, ipAddress, details === null ? null : JSON.stringify(sanitizeAuditData(details))],
  ).catch((error) => console.error('Unable to write audit log:', error.message));
};

app.locals.writeAuditLog = writeAuditLog;
app.locals.pendingRouteToasts = pendingRouteToasts;

const getAuthToken = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookiePairs = cookieHeader.split(';').map((part) => part.trim());
  const authCookie = cookiePairs.find((cookie) => cookie.startsWith('auth='));
  return authCookie ? authCookie.slice('auth='.length) : null;
};

const consumePendingRouteToast = (userId) => {
  if (typeof userId === 'undefined' || userId === null) return null;
  const toast = pendingRouteToasts.get(userId);
  if (typeof toast !== 'undefined') {
    pendingRouteToasts.delete(userId);
    return toast;
  }
  return null;
};

const revokeUserSessions = (userId) => {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) sessions.delete(token);
  }
};

app.use((req, res, next) => {
  if (MUTATION_METHODS.has(req.method) && getAuthToken(req)) return requireSameOrigin(req, res, next);
  return next();
});

app.use(auditActivity);
// The header highlights the section being viewed. Taken here, before any router strips its prefix.
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

const requireAuth = async (req, res, next) => {
  const token = getAuthToken(req);
  if (!token || !sessions.has(token)) {
    return res.redirect('/');
  }

  const session = sessions.get(token);
  const now = Date.now();
  if (isSessionExpired(session, now)) {
    sessions.delete(token);
    res.clearCookie('auth', buildSessionCookieOptions());
    return res.redirect('/');
  }

  try {
    const [rows] = await pool.execute('SELECT password, is_active, is_admin, role, must_change_password FROM users WHERE id = ?', [session.userId]);
    if (rows.length !== 1 || Number(rows[0].is_active) !== 1 || session.credentialHash !== rows[0].password || sessions.get(token) !== session) {
      sessions.delete(token);
      res.clearCookie('auth', buildSessionCookieOptions());
      return res.redirect('/');
    }

    session.lastActivity = now;
    session.isAdmin = Number(rows[0].is_admin) === 1 || rows[0].role === 'admin';
    session.role = session.isAdmin ? 'admin' : (rows[0].role || 'usuario');
    session.mustChangePassword = Number(rows[0].must_change_password) === 1;
    sessions.set(token, session);
    req.session = session;
    res.locals.currentUser = {
      id: session.userId,
      email: session.email,
      isAdmin: session.isAdmin === true,
      role: session.role,
      canEditRecords: session.isAdmin === true || session.role === 'semiadmin',
    };

    const pendingToast = consumePendingRouteToast(session.userId);
    if (pendingToast) {
      res.locals.toastMessage = pendingToast.message;
      res.locals.toastFileId = pendingToast.fileId;
    }
    const requestPath = req.originalUrl.split('?')[0];
    if (session.mustChangePassword && requestPath !== '/cambiar-contrasena') {
      return res.redirect('/cambiar-contrasena');
    }
    next();
  } catch (error) {
    next(error);
  }
};

const requireAdmin = async (req, res, next) => {
  requireAuth(req, res, async () => {
    try {
      const [rows] = await pool.execute('SELECT is_admin, role FROM users WHERE id = ?', [req.session.userId]);
      const isAdmin = rows.length === 1 && (Number(rows[0].is_admin) === 1 || rows[0].role === 'admin');
      req.session.isAdmin = isAdmin;

      if (!isAdmin) {
        return res.status(403).redirect('/Crud');
      }

      res.locals.currentUser.isAdmin = true;
      next();
    } catch (error) {
      next(error);
    }
  });
};

// The API documentation lists every route, so only administrators may read it.
app.use('/api-docs', requireAdmin, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const requireNonUecs = (req, res, next) => {
  if (req.session.role === 'uecs') {
    return res.status(403).redirect('/Crud');
  }
  return next();
};

app.use(['/metricas', '/Crud', '/imei', '/lineas', '/ubicaciones', '/api/ubicaciones', '/estudiantes', '/georeferenciacion', '/ruta', '/inicio', '/telefono', '/api/telefono', '/api/localidades', '/cambiar-contrasena'], requireAuth);
app.use('/metricas', requireNonUecs);
// The web tab and the Telegram bot share one Maigret queue.
const maigretSearches = createMaigretSearches(pool);
app.use('/api/bot', createTelegramApiRouter(pool, process.env, undefined, undefined, maigretSearches));
app.use('/planeacion-geografica', requireAuth, createPlaneacionRouter(pool));
app.use('/coincidencias', requireAuth, createCoincidenciasRouter(pool));
app.use('/maigret', requireAuth, createMaigretRouter(pool, { searches: maigretSearches }));
app.use('/imagenes', requireAuth, createImagenesRouter(pool));
app.use('/nombres', requireAuth, createNombresRouter(pool, { maigretSearches }));
app.use('/perfiles', requireAuth, createPerfilesRouter(pool));
app.use('/tareas', requireAuth, requireNonUecs, createTareasRouter(pool));
// Reverse image search engines download the image without a session, through an expiring token.
app.use('/imagen-publica', createPublicImageRouter(pool));





//Establece el motor de plantillas
app.set("view engine", "ejs");
app.set("views", "./views");

app.post('/login', requireSameOrigin, async (req, res) => {
  const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    const retryAfterMs = loginRateLimiter.retryAfterMs(req.ip, normalizedEmail);
    if (retryAfterMs > 0) {
        const minutes = Math.ceil(retryAfterMs / 60000);
        writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 429, ipAddress: req.ip });
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        return res.status(429).render('index', { error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto(s).`, success: null });
    }

    if (!email || !password) {
        writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 400, ipAddress: req.ip });
        return res.render('index', { error: 'Email and password are required.', success: null });
    }

    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
        if (rows.length === 0) {
            loginRateLimiter.recordFailure(req.ip, normalizedEmail);
            writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 401, ipAddress: req.ip });
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        const user = rows[0];
        const isMatch = await verifyPassword(password, user.password);

        if (!isMatch) {
            loginRateLimiter.recordFailure(req.ip, normalizedEmail);
            writeAuditLog({ userId: user.id, userEmail: user.email, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 401, ipAddress: req.ip });
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        loginRateLimiter.recordSuccess(normalizedEmail);

        const authToken = crypto.randomBytes(24).toString('hex');
        const shouldRemember = false;
        sessions.set(authToken, {
          userId: user.id,
          credentialHash: user.password,
          email: user.email,
          isAdmin: Number(user.is_admin) === 1 || user.role === 'admin',
          role: Number(user.is_admin) === 1 ? 'admin' : (user.role || 'usuario'),
          mustChangePassword: Number(user.must_change_password) === 1,
          rememberMe: shouldRemember,
          lastActivity: Date.now()
        });
        res.cookie('auth', authToken, buildSessionCookieOptions(shouldRemember));
        writeAuditLog({ userId: user.id, userEmail: user.email, action: 'LOGIN', requestPath: '/login', statusCode: 302, ipAddress: req.ip });

        return res.redirect(Number(user.must_change_password) === 1 ? '/cambiar-contrasena' : '/Crud');
    } catch (error) {
        console.error(error.stack || error);
        writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 500, ipAddress: req.ip });
        return res.render('index', { error: 'Internal server error.', success: null });
    }
});

app.get('/logout', (req, res) => {
  const token = getAuthToken(req);
  if (token) {
    sessions.delete(token);
  }

  res.clearCookie('auth', buildSessionCookieOptions());
  return res.redirect('/');
});

app.get('/api/route-toast', async (req, res) => {
  const token = getAuthToken(req);
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ message: null, fileId: null });
  }

  const session = sessions.get(token);
  const now = Date.now();
  if (isSessionExpired(session, now)) {
    sessions.delete(token);
    res.clearCookie('auth', buildSessionCookieOptions());
    return res.status(401).json({ message: null, fileId: null });
  }

  const pendingToast = consumePendingRouteToast(session.userId);
  return res.json({
    message: pendingToast ? pendingToast.message : null,
    fileId: pendingToast ? pendingToast.fileId : null,
  });
});

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check básico
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: La aplicación está funcionando
 */
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Verificación de disponibilidad de la base de datos
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: La aplicación y la base de datos están listas
 *       503:
 *         description: La aplicación no está lista
 */
app.get('/health/ready', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    const ready = Array.isArray(rows) && rows.length > 0;

    if (!ready) {
      return res.status(503).json({
        status: 'not-ready',
        timestamp: new Date().toISOString(),
        database: 'unavailable',
      });
    }

    return res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      database: 'ok',
    });
  } catch (error) {
    return res.status(503).json({
      status: 'not-ready',
      timestamp: new Date().toISOString(),
      database: 'error',
    });
  }
});

// Carga la página de inicio
app.get("/", (req, res) => {
  res.render("index", { error: null, success: null });
});

app.get('/terminos', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.render('pages/terminos');
});

app.get('/inicio', (req, res) => {
  res.render('inicio');
});

app.get('/cambiar-contrasena', requireAuth, (req, res) => {
  return res.render('pages/cambiar-contrasena', { error: null });
});

app.post('/cambiar-contrasena', requireSameOrigin, requireAuth, async (req, res, next) => {
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  // Capture the credential before bcrypt yields; other requests may rotate sessions.
  const expectedCredentialHash = req.session.credentialHash;

  if (password.length < 8) {
    return res.status(400).render('pages/cambiar-contrasena', { error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).render('pages/cambiar-contrasena', { error: 'Las contraseñas no coinciden.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const [result] = await pool.execute(
      'UPDATE users SET password = ?, must_change_password = 0 WHERE id = ? AND BINARY password = ?',
      [passwordHash, req.session.userId, expectedCredentialHash],
    );
    if (result.affectedRows !== 1) {
      sessions.delete(getAuthToken(req));
      res.clearCookie('auth', buildSessionCookieOptions());
      return res.redirect('/');
    }
    revokeUserSessions(req.session.userId);
    req.session = { ...req.session, credentialHash: passwordHash, mustChangePassword: false, lastActivity: Date.now() };
    const authToken = crypto.randomBytes(24).toString('hex');
    sessions.set(authToken, req.session);
    res.cookie('auth', authToken, buildSessionCookieOptions());
    const notification = await notifyUser(req.session.email, 'changed');
    if (!notification.sent) {
      return res.render('pages/cambiar-contrasena', { error: `Contraseña actualizada. ${notification.warning}`, completed: true });
    }
    return res.redirect('/Crud');
  } catch (error) {
    return next(error);
  }
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const generateSecurePassword = () => crypto.randomBytes(24).toString('base64url');

// Every admin form redirects after saving (so reloading never repeats the action) and leaves its
// result in the session; messages never come from the URL, where anyone could write them.
const redirectWithFlash = (req, res, path, { message = null, error = null, toast = null } = {}) => {
  if (req.session) req.session.flash = { message, error, toast };
  return res.redirect(303, path);
};

const takeFlash = (req, res) => {
  const flash = req.session?.flash || {};
  if (req.session) delete req.session.flash;
  if (flash.toast) {
    res.locals.toastMessage = flash.toast.message;
    res.locals.toastTitle = flash.toast.title;
  }
  return { message: flash.message || null, error: flash.error || null };
};

const toUsers = (req, res, flash) => redirectWithFlash(req, res, '/usuarios', flash);

app.get('/usuarios', requireAdmin, async (req, res, next) => {
  try {
    const { users, counts } = await listarUsuarios(pool, decryptTelegramId);
    return res.render('pages/usuarios', {
      ...takeFlash(req, res), users, counts, roleLabels, roleDescriptions, userRoles,
      currentUserIsInitialAdmin: users.some((user) => user.id === req.session.userId && user.isInitialAdmin),
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/medidores/google-geocoding/reiniciar', requireAdmin, async (req, res, next) => {
  try {
    await resetGoogleGeocodingQuota(pool);
    return redirectWithFlash(req, res, '/medidores', { message: 'Contador de Google Geocoding reiniciado y servicio desbloqueado.' });
  } catch (error) {
    return next(error);
  }
});

app.get('/auditoria', requireAdmin, async (req, res, next) => {
  try {
    let selection;
    let filterError = null;
    try {
      selection = buildAuditFilters(req.query);
    } catch (error) {
      filterError = error.message;
      selection = buildAuditFilters();
      for (const key of Object.keys(selection.filters)) {
        if (typeof req.query[key] === 'string') selection.filters[key] = req.query[key].slice(0, 255);
      }
    }
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const result = filterError
      ? { entries: [], summary: { total: 0, usuarios: 0, errores: 0, denegados: 0, fallidos: 0 }, failedByIp: [], page: 1, totalPages: 1,
        users: (await pool.query("SELECT DISTINCT user_email FROM audit_logs WHERE user_email <> '' ORDER BY user_email"))[0] }
      : await consultarAuditoria(pool, selection, page);
    return res.status(filterError ? 400 : 200).render('pages/auditoria', {
      ...result, filters: selection.filters, filterError, auditActionLabels, auditResources, auditResults, auditOrigins, auditFilterQuery,
      exportLimit: AUDIT_EXPORT_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/auditoria/exportar', requireAdmin, async (req, res, next) => {
  let selection;
  try {
    selection = buildAuditFilters(req.query);
  } catch (error) {
    return res.status(400).type('text/plain').send(error.message);
  }
  try {
    const { csv } = await exportarAuditoriaCsv(pool, selection);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="auditoria-${stamp}.csv"`);
    return res.type('text/csv; charset=utf-8').send(csv);
  } catch (error) {
    return next(error);
  }
});

app.use('/red-telefonica', requireAdmin, createRedTelefonicaRouter(pool));

app.get('/medidores', requireAdmin, async (req, res, next) => {
  try {
    return res.render('pages/medidores', {
      ...await obtenerMedidores(pool),
      ...takeFlash(req, res),
      cartoApiKey: process.env.CARTO_API_KEY || '',
    });
  } catch (error) {
    return next(error);
  }
});

// Polled by the open page; listed as a background path so it does not flood the audit log.
app.get('/medidores/resumen', requireAdmin, async (req, res, next) => {
  try {
    return res.render('partials/medidores-resumen', await obtenerMedidores(pool));
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios', requireAdmin, async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = userRoles.includes(req.body.role) ? req.body.role : 'usuario';
  if (!EMAIL_PATTERN.test(email)) {
    return toUsers(req, res, { error: 'Ingresa un correo electrónico válido.' });
  }

  const generatedPassword = generateSecurePassword();
  try {
    const passwordHash = await hashPassword(generatedPassword);
    await pool.execute('INSERT INTO users (email, password, is_admin, role, must_change_password) VALUES (?, ?, ?, ?, 1)', [email, passwordHash, role === 'admin' ? 1 : 0, role]);
    const notification = await notifyUser(email, 'created', { temporaryPassword: generatedPassword });
    return toUsers(req, res, {
      error: notification.sent ? null : `${notification.warning} Restablece la contraseña para recuperar el acceso del usuario.`,
      message: notification.sent
        ? `Usuario creado para ${email}. La contraseña temporal se envió a su correo.`
        : `Usuario creado para ${email}. No se pudo enviar la contraseña temporal.`,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return toUsers(req, res, { error: 'Ese correo ya está registrado.' });
    }
    return next(error);
  }
});

// Only the initial administrator may change their own role, status or password.
const protectsInitialAdmin = (target, req) => Number(target.is_initial_admin) === 1 && target.id !== req.session.userId;

app.post('/usuarios/:id/restablecer-contrasena', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(userId) || userId < 1) return toUsers(req, res, { error: 'Usuario inválido.' });

  try {
    const [users] = await pool.execute('SELECT id, is_initial_admin, email FROM users WHERE id = ?', [userId]);
    if (users.length !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    if (protectsInitialAdmin(users[0], req)) {
      return toUsers(req, res, { error: 'Solo el administrador inicial puede cambiar su contraseña.' });
    }

    const generatedPassword = generateSecurePassword();
    const passwordHash = await hashPassword(generatedPassword);
    const [result] = await pool.execute('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?', [passwordHash, userId]);
    if (result.affectedRows !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    revokeUserSessions(userId);
    if (userId === req.session.userId) res.clearCookie('auth', buildSessionCookieOptions());
    const notification = await notifyUser(users[0].email, 'reset', { temporaryPassword: generatedPassword });
    return toUsers(req, res, {
      message: notification.sent
        ? 'Contraseña restablecida. La contraseña temporal se envió al correo del usuario.'
        : 'Contraseña restablecida. No se pudo enviar la contraseña temporal.',
      error: notification.sent ? null : `${notification.warning} Revisa la configuración del correo y vuelve a restablecer la contraseña para generar y enviar una nueva.`,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios/:id/rol', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  const role = userRoles.includes(req.body.role) ? req.body.role : 'usuario';
  const isAdmin = role === 'admin';
  if (!Number.isSafeInteger(userId) || userId < 1) return toUsers(req, res, { error: 'Usuario inválido.' });
  if (userId === req.session.userId && !isAdmin) return toUsers(req, res, { error: 'No puedes quitarte tu propio acceso de administrador.' });

  try {
    const [targets] = await pool.execute('SELECT id, email, is_admin, role, is_initial_admin FROM users WHERE id = ?', [userId]);
    if (targets.length !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    const target = targets[0];
    if (protectsInitialAdmin(target, req)) {
      return toUsers(req, res, { error: 'Solo el administrador inicial puede cambiar su propio rol.' });
    }
    if (userRoleOf(target) === role) {
      return toUsers(req, res, { message: `${target.email} ya tiene el rol ${roleLabels[role]}; no se hizo ningún cambio.` });
    }

    // Only demoting the last administrator is blocked; other users can move between non-admin roles freely.
    if (!isAdmin) {
      const [[{ adminCount, targetIsAdmin }]] = await pool.execute(
        `SELECT SUM(is_admin = 1 OR role = 'admin') AS adminCount,
                MAX(id = ? AND (is_admin = 1 OR role = 'admin')) AS targetIsAdmin
         FROM users`,
        [userId],
      );
      if (Number(targetIsAdmin) === 1 && Number(adminCount) <= 1) return toUsers(req, res, { error: 'Debe existir al menos un administrador.' });
    }

    const [result] = await pool.execute('UPDATE users SET is_admin = ?, role = ? WHERE id = ?', [isAdmin ? 1 : 0, role, userId]);
    if (result.affectedRows !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    return toUsers(req, res, { message: `Rol de ${target.email} cambiado a ${roleLabels[role]}.` });
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios/:id/telegram', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  const telegramId = String(req.body.telegramId || '').trim();
  if (!Number.isSafeInteger(userId) || userId < 1) return toUsers(req, res, { error: 'Usuario inválido.' });
  if (telegramId && !/^[1-9]\d{0,19}$/.test(telegramId)) return toUsers(req, res, { error: 'El ID de Telegram debe ser numérico.' });

  try {
    const [users] = await pool.execute('SELECT id, email, telegram_id_hash FROM users WHERE id = ?', [userId]);
    if (users.length !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    // Saving the same ID again must not restart the bot for everyone.
    if ((telegramId ? telegramIdHash(telegramId) : null) === (users[0].telegram_id_hash || null)) {
      return toUsers(req, res, { message: `El ID de Telegram de ${users[0].email} no cambió.` });
    }
    if (!telegramId) {
      await pool.execute('UPDATE users SET telegram_id_encrypted = NULL, telegram_id_hash = NULL WHERE id = ?', [userId]);
    } else {
      const { encrypted, hash } = encryptTelegramId(telegramId);
      await pool.execute('UPDATE users SET telegram_id_encrypted = ?, telegram_id_hash = ? WHERE id = ?', [encrypted, hash, userId]);
    }
    const message = telegramId ? `ID de Telegram de ${users[0].email} actualizado.` : `Telegram desvinculado de ${users[0].email}.`;
    try {
      await restartTelegramBot();
    } catch (restartError) {
      console.error('No se pudo reiniciar el bot de Telegram:', restartError.message);
      return toUsers(req, res, {
        message,
        error: 'El ID se guardó, pero no se pudo reiniciar el bot. Revisa el proceso de Telegram en PM2.',
      });
    }
    return toUsers(req, res, { message, toast: { message: 'Bot actualizado', title: 'Telegram' } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return toUsers(req, res, { error: 'Ese ID de Telegram ya está vinculado a otro usuario.' });
    return next(error);
  }
});

app.post('/usuarios/:id/estado', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  const isActive = req.body.isActive === '1';
  if (!Number.isSafeInteger(userId) || userId < 1) return toUsers(req, res, { error: 'Usuario inválido.' });
  if (userId === req.session.userId && !isActive) return toUsers(req, res, { error: 'No puedes deshabilitar tu propia cuenta.' });

  try {
    const [users] = await pool.execute('SELECT id, email, is_initial_admin FROM users WHERE id = ?', [userId]);
    if (users.length !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    if (protectsInitialAdmin(users[0], req)) {
      return toUsers(req, res, { error: 'El administrador inicial no puede ser deshabilitado por otro usuario.' });
    }
    const [result] = await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
    if (result.affectedRows !== 1) return toUsers(req, res, { error: 'Usuario no encontrado.' });
    if (!isActive) revokeUserSessions(userId);
    return toUsers(req, res, { message: `${users[0].email} ${isActive ? 'habilitado' : 'deshabilitado'}.` });
  } catch (error) {
    return next(error);
  }
});

// Usa el enrutador para las rutas relacionadas con estudiantes
app.use("/", router);

app.use((req, res) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ruta no encontrada.' });
  }
  return res.status(404).render('404');
});

app.use(handleErrors);

const CERT_DIR = path.resolve('./certs');
const hasConfiguredTls = Boolean(process.env.TLS_KEY_PATH || process.env.TLS_CERT_PATH);
if (hasConfiguredTls && (!process.env.TLS_KEY_PATH || !process.env.TLS_CERT_PATH)) {
  throw new Error('Configura TLS_KEY_PATH y TLS_CERT_PATH juntos.');
}
// New filenames prevent automatic reuse of credentials previously tracked by Git.
const CERT_KEY_PATH = hasConfiguredTls ? path.resolve(process.env.TLS_KEY_PATH) : path.join(CERT_DIR, 'runtime-server.key');
const CERT_CERT_PATH = hasConfiguredTls ? path.resolve(process.env.TLS_CERT_PATH) : path.join(CERT_DIR, 'runtime-server.crt');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3600);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

const ensureLocalCerts = () => {
  const keyExists = fs.existsSync(CERT_KEY_PATH);
  const certExists = fs.existsSync(CERT_CERT_PATH);
  if (keyExists && certExists) return;
  if (hasConfiguredTls || keyExists || certExists) {
    throw new Error('Falta el par TLS configurado. No se sobrescriben credenciales existentes.');
  }
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }

  console.log('Generando certificados HTTPS auto-firmados para desarrollo local...');
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 365,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });

  fs.writeFileSync(CERT_KEY_PATH, pems.private, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(CERT_CERT_PATH, pems.cert, { flag: 'wx', mode: 0o600 });
  console.log('Certificados HTTPS generados en:', CERT_DIR);
};


// Managed hosting terminates public HTTPS and forwards HTTP to PORT.
const serverProtocol = process.env.SERVER_PROTOCOL || (process.env.NODE_ENV === 'production' ? 'http' : 'https');
if (!['http', 'https'].includes(serverProtocol)) {
  throw new Error('SERVER_PROTOCOL debe ser http o https.');
}
if (serverProtocol === 'http') {
  http.createServer(app).listen(PORT, HOST, () => console.log(`Servidor HTTP en ${HOST}:${PORT}`));
} else {
  ensureLocalCerts();
  https.createServer({
    key: fs.readFileSync(CERT_KEY_PATH),
    cert: fs.readFileSync(CERT_CERT_PATH),
  }, app).listen(HTTPS_PORT, HOST, () => console.log(`Servidor HTTPS en ${HOST}:${HTTPS_PORT}`));
}

startImeiMetadataDailyJob((result) => {
  if (result && result.error) {
    console.log('Error en la revisión diaria de IMEI:', result.error);
  } else if (result && result.processed) {
    console.log(`Revisión diaria de IMEI completada: ${result.processed} registros revisados, ${result.updated} actualizados`);
  }
});
