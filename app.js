import "dotenv/config";
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import mysql from 'mysql2/promise';
import express from "express";
import cors from "cors";
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import router from "./src/router.js"; // Importa el enrutador
import pool from "./src/db.js";
import { buildAuditFilters, auditActionLabels } from './src/auditFilters.js';
import { auditOperationSql, auditResourceSql, auditResources, describeAuditAction, auditRequestPath } from './src/auditActions.js';
import { buildSessionCookieOptions, isSessionExpired, SESSION_TIMEOUT_MS } from './src/sessionUtils.js';
import { startImeiMetadataDailyJob } from './src/imeiMetadataService.js';
import { hashPassword, verifyPassword } from './src/passwordUtils.js';
import { buildAuditDetails, sanitizeAuditData } from './src/auditDetails.js';
import { requireSameOrigin } from './src/requestSecurity.js';
import { createTelegramApiRouter } from './src/telegramApiRouter.js';
import { createPlaneacionRouter } from './src/planeacionRouter.js';


const app = express();
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
  apis: ['./app.js', './src/router.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 50000 }));
app.use("/public", express.static(fileURLToPath(new URL('./public/', import.meta.url))));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const sessions = new Map();
const pendingRouteToasts = new Map();
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NON_MUTATING_POST_PATHS = new Set(['/api/telefono/validar']);

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

app.use((req, res, next) => {
  res.on('finish', () => {
    const requestPath = req.path;
    const isAuditable = MUTATION_METHODS.has(req.method) && !NON_MUTATING_POST_PATHS.has(requestPath);
    if (!isAuditable || !req.session || res.statusCode < 200 || res.statusCode >= 400) return;

    writeAuditLog({
      userId: req.session.userId,
      userEmail: req.session.email,
      action: req.method,
      requestPath: auditRequestPath(requestPath, req.query),
      statusCode: res.statusCode,
      ipAddress: req.ip,
      details: buildAuditDetails(req),
    });
  });
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

const requireNonUecs = (req, res, next) => {
  if (req.session.role === 'uecs') {
    return res.status(403).redirect('/Crud');
  }
  return next();
};

app.use(['/metricas', '/Crud', '/imei', '/lineas', '/ubicaciones', '/api/ubicaciones', '/estudiantes', '/georeferenciacion', '/ruta', '/inicio', '/telefono', '/api/telefono', '/api/localidades', '/cambiar-contrasena'], requireAuth);
app.use('/metricas', requireNonUecs);
app.use('/api/bot', createTelegramApiRouter(pool));
app.use('/planeacion-geografica', requireAdmin, createPlaneacionRouter(pool));





/**
 * @openapi
 * /api/login:
 *   post:
 *     summary: Login de usuario
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: admin@crududai.com
 *               password:
 *                 type: string
 *                 example: secret123
 *     responses:
 *       200:
 *         description: Login exitoso
 *       400:
 *         description: Faltan credenciales
 *       401:
 *         description: Credenciales inválidas
 *       500:
 *         description: Error del servidor
 */
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    // 1. Basic validation
    if (!email || !password) {
        writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/api/login', statusCode: 400, ipAddress: req.ip });
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        // 2. Safely query the user using prepared statements to avoid SQL Injection
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
        
        if (rows.length === 0) {
            writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/api/login', statusCode: 401, ipAddress: req.ip });
            return res.status(401).json({ message: 'Invalid email credentials.' });
        }

        const user = rows[0];

        // Passwords must have been migrated to bcrypt before they can be used.
        const isMatch = await verifyPassword(password, user.password);

        if (!isMatch) {
            writeAuditLog({ userId: user.id, userEmail: user.email, action: 'LOGIN_FAILED', requestPath: '/api/login', statusCode: 401, ipAddress: req.ip });
            return res.status(401).json({ message: 'Invalid password credentials.' });
        }

        // 4. Success handling (Here, you would typically issue a session or JWT)
        writeAuditLog({ userId: user.id, userEmail: user.email, action: 'LOGIN', requestPath: '/api/login', statusCode: 200, ipAddress: req.ip });
        return res.status(200).json({
            message: 'Login successful!',
          user: { id: user.id, email: user.email },
          mustChangePassword: Number(user.must_change_password) === 1,
            
        });

} catch (error) {
        // This prints the exact file, line number, and error cause to your Node terminal
        console.error('--- CRITICAL ERROR DIAGNOSTIC ---');
        console.error(error.stack || error);
        console.error('---------------------------------');
        writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/api/login', statusCode: 500, ipAddress: req.ip });
        
        // This sends the exact problem straight back to your Postman screen
        return res.status(500).json({ 
            message: 'An internal server error occurred.',
            errorType: error.name,
            errorMessage: error.message 
        });
    }
});

//Establece el motor de plantillas
app.set("view engine", "ejs");
app.set("views", "./views");

app.post('/login', requireSameOrigin, async (req, res) => {
  const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!email || !password) {
        writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 400, ipAddress: req.ip });
        return res.render('index', { error: 'Email and password are required.', success: null });
    }

    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
        if (rows.length === 0) {
            writeAuditLog({ userEmail: normalizedEmail, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 401, ipAddress: req.ip });
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        const user = rows[0];
        const isMatch = await verifyPassword(password, user.password);

        if (!isMatch) {
            writeAuditLog({ userId: user.id, userEmail: user.email, action: 'LOGIN_FAILED', requestPath: '/login', statusCode: 401, ipAddress: req.ip });
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

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

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
});

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
      error: error.message || 'Database check failed',
    });
  }
});

// Carga la página de inicio
app.get("/", (req, res) => {
  res.render("index", { error: null, success: null });
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
    return res.redirect('/Crud');
  } catch (error) {
    return next(error);
  }
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const generateSecurePassword = () => crypto.randomBytes(24).toString('base64url');

const renderUsersPage = async (res, { message = null, error = null, generatedPassword = null } = {}) => {
  const [users] = await pool.execute('SELECT id, email, is_admin, role, is_active, is_initial_admin FROM users ORDER BY email ASC');
  return res.render('pages/usuarios', { users, message, error, generatedPassword });
};

app.get('/usuarios', requireAdmin, async (req, res, next) => {
  try {
    await renderUsersPage(res, { message: req.query.message || null, error: req.query.error || null });
  } catch (error) {
    next(error);
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
    const [users] = await pool.execute("SELECT DISTINCT user_email FROM audit_logs WHERE user_email <> '' ORDER BY user_email");
    const [entries] = filterError ? [[]] : await pool.execute(
      `SELECT user_email, method, request_path, status_code, ip_address, details,
              ${auditOperationSql} AS operation, ${auditResourceSql} AS resource,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM audit_logs
       ${selection.where}
       ORDER BY id DESC
       LIMIT 200`,
      selection.values,
    );
    return res.status(filterError ? 400 : 200).render('pages/auditoria', {
      entries, users, filters: selection.filters, filterError, auditActionLabels, auditResources, describeAuditAction,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/red-telefonica', requireAdmin, async (req, res, next) => {
  try {
    const [crossings] = await pool.execute(`
      SELECT c.contacto, o.idObjetivo, o.numObjetivo, o.nuc, o.tipo, o.ano
      FROM contactos c
      INNER JOIN objetivo o ON o.idObjetivo = c.idObjetivo
      INNER JOIN (
        SELECT contacto
        FROM contactos
        WHERE CHAR_LENGTH(CAST(contacto AS CHAR)) >= 10
        GROUP BY contacto
        HAVING COUNT(DISTINCT idObjetivo) > 1
        ORDER BY COUNT(DISTINCT idObjetivo) DESC, contacto ASC
        LIMIT 100
      ) cruzados ON cruzados.contacto = c.contacto
      WHERE CHAR_LENGTH(CAST(c.contacto AS CHAR)) >= 10
      ORDER BY c.contacto, o.numObjetivo
    `);

    const nodes = new Map();
    const links = [];
    const crossingDetails = new Map();

    for (const row of crossings) {
      const phone = String(row.contacto);
      const phoneId = `phone:${phone}`;
      const objectiveId = `objective:${row.idObjetivo}`;
      if (!nodes.has(phoneId)) nodes.set(phoneId, { id: phoneId, label: phone, type: 'phone' });
      if (!nodes.has(objectiveId)) {
        nodes.set(objectiveId, {
          id: objectiveId,
          label: String(row.numObjetivo),
          type: 'objective',
          detail: `${row.nuc} · ${row.tipo} · ${row.ano}`,
        });
      }
      links.push({ source: phoneId, target: objectiveId });
      if (!crossingDetails.has(phone)) crossingDetails.set(phone, []);
      crossingDetails.get(phone).push({
        objetivo: row.numObjetivo,
        nuc: row.nuc,
        tipo: row.tipo,
        ano: row.ano,
      });
    }

    return res.render('pages/red-telefonica', {
      graph: { nodes: [...nodes.values()], links },
      crossingDetails: [...crossingDetails].map(([contacto, objetivos]) => ({ contacto, objetivos })),
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/medidores', requireAdmin, async (req, res, next) => {
  try {
    const [[metricRows], [antennaRows]] = await Promise.all([
      pool.query(`
      SELECT
        (SELECT COUNT(*) FROM objetivo) AS objetivos,
        (SELECT COUNT(*) FROM objetivoImei) AS objetivosImei,
        (SELECT COUNT(*) FROM imei) AS imeis,
        (SELECT COUNT(*) FROM contactos) AS contactos,
        (SELECT COUNT(*) FROM ubicaciones) AS ubicaciones,
        (SELECT COUNT(*) FROM users) AS usuarios,
        (SELECT COUNT(*) FROM imei WHERE brand_name IS NOT NULL AND modelo IS NOT NULL) AS imeisConMetadata,
        (SELECT COUNT(*) FROM imei WHERE brand_name IS NULL OR modelo IS NULL) AS imeisPendientes
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(lugar), ''), 'Sin ciudad') AS ciudad, COUNT(*) AS total
        FROM ubicaciones
        GROUP BY COALESCE(NULLIF(TRIM(lugar), ''), 'Sin ciudad')
        ORDER BY total DESC, ciudad ASC
      `),
    ]);

    const metrics = Object.fromEntries(
      Object.entries(metricRows[0] || {}).map(([key, value]) => [key, Number(value) || 0]),
    );
    const antennasByCity = antennaRows.map(({ ciudad, total }) => ({
      ciudad,
      total: Number(total) || 0,
    }));
    return res.render('pages/medidores', {
      metrics,
      antennasByCity,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
      cartoApiKey: process.env.CARTO_API_KEY,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios', requireAdmin, async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = ['admin', 'semiadmin', 'usuario', 'uecs'].includes(req.body.role) ? req.body.role : 'usuario';
  if (!EMAIL_PATTERN.test(email)) {
    return renderUsersPage(res, { error: 'Ingresa un correo electrónico válido.' }).catch(next);
  }

  const generatedPassword = generateSecurePassword();
  try {
    const passwordHash = await hashPassword(generatedPassword);
    await pool.execute('INSERT INTO users (email, password, is_admin, role, must_change_password) VALUES (?, ?, ?, ?, 1)', [email, passwordHash, role === 'admin' ? 1 : 0, role]);
    return renderUsersPage(res, {
      message: `Usuario creado para ${email}. Copia la contraseña antes de salir de esta página.`,
      generatedPassword,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return renderUsersPage(res, { error: 'Ese correo ya está registrado.' }).catch(next);
    }
    return next(error);
  }
});

app.post('/usuarios/:id/restablecer-contrasena', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).redirect('/usuarios?error=Usuario%20inválido.');

  try {
    const [users] = await pool.execute('SELECT is_initial_admin FROM users WHERE id = ?', [userId]);
    if (users.length !== 1) return res.status(404).redirect('/usuarios?error=Usuario%20no%20encontrado.');
    if (Number(users[0].is_initial_admin) === 1 && userId !== req.session.userId) {
      return res.status(403).redirect('/usuarios?error=Solo%20el%20administrador%20inicial%20puede%20cambiar%20su%20contrase%C3%B1a.');
    }

    const generatedPassword = generateSecurePassword();
    const passwordHash = await hashPassword(generatedPassword);
    const [result] = await pool.execute('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?', [passwordHash, userId]);
    if (result.affectedRows !== 1) return res.status(404).redirect('/usuarios?error=Usuario%20no%20encontrado.');
    revokeUserSessions(userId);
    if (userId === req.session.userId) res.clearCookie('auth', buildSessionCookieOptions());
    return renderUsersPage(res, { message: 'Contraseña restablecida. Cópiala antes de salir de esta página.', generatedPassword });
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios/:id/rol', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  const role = ['admin', 'semiadmin', 'usuario', 'uecs'].includes(req.body.role) ? req.body.role : 'usuario';
  const isAdmin = role === 'admin';
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).redirect('/usuarios?error=Usuario%20inválido.');
  if (userId === req.session.userId && !isAdmin) return res.redirect('/usuarios?error=No%20puedes%20quitarte%20tu%20propio%20acceso%20de%20administrador.');

  try {
    if (!isAdmin) {
      const [[{ adminCount }]] = await pool.execute('SELECT COUNT(*) AS adminCount FROM users WHERE is_admin = 1');
      if (Number(adminCount) <= 1) return res.redirect('/usuarios?error=Debe%20existir%20al%20menos%20un%20administrador.');
    }

    const [result] = await pool.execute('UPDATE users SET is_admin = ?, role = ? WHERE id = ?', [isAdmin ? 1 : 0, role, userId]);
    if (result.affectedRows !== 1) return res.status(404).redirect('/usuarios?error=Usuario%20no%20encontrado.');
    return res.redirect('/usuarios?message=Rol%20actualizado.');
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios/:id/estado', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  const isActive = req.body.isActive === '1';
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).redirect('/usuarios?error=Usuario%20inv%C3%A1lido.');
  if (userId === req.session.userId && !isActive) return res.redirect('/usuarios?error=No%20puedes%20deshabilitar%20tu%20propia%20cuenta.');

  try {
    const [result] = await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
    if (result.affectedRows !== 1) return res.status(404).redirect('/usuarios?error=Usuario%20no%20encontrado.');
    if (!isActive) revokeUserSessions(userId);
    return res.redirect(`/usuarios?message=${encodeURIComponent(isActive ? 'Usuario habilitado.' : 'Usuario deshabilitado.')}`);
  } catch (error) {
    return next(error);
  }
});

// Usa el enrutador para las rutas relacionadas con estudiantes
app.use("/", router);

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
