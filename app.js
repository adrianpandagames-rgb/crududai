import "dotenv/config";
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import selfsigned from 'selfsigned';
import mysql from 'mysql2/promise';
import express from "express";
import cors from "cors";
import router from "./src/router.js"; // Importa el enrutador
import pool from "./src/db.js";
import { buildSessionCookieOptions, isSessionExpired, SESSION_TIMEOUT_MS } from './src/sessionUtils.js';
import { startImeiMetadataDailyJob } from './src/imeiMetadataService.js';
import { hashPassword, verifyPassword } from './src/passwordUtils.js';


const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 50000 }));
app.use("/public", express.static("public"));

const sessions = new Map();
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NON_MUTATING_POST_PATHS = new Set(['/api/telefono/validar']);

const getAuthToken = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookiePairs = cookieHeader.split(';').map((part) => part.trim());
  const authCookie = cookiePairs.find((cookie) => cookie.startsWith('auth='));
  return authCookie ? authCookie.slice('auth='.length) : null;
};

const revokeUserSessions = (userId) => {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) sessions.delete(token);
  }
};

app.use((req, res, next) => {
  res.on('finish', () => {
    const requestPath = req.path;
    const isAuditable = MUTATION_METHODS.has(req.method) && !NON_MUTATING_POST_PATHS.has(requestPath);
    if (!isAuditable || !req.session || res.statusCode < 200 || res.statusCode >= 400) return;

    pool.execute(
      `INSERT INTO audit_logs (user_id, user_email, method, request_path, status_code, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.userId, req.session.email, req.method, requestPath, res.statusCode, req.ip],
    ).catch((error) => console.error('Unable to write audit log:', error.message));
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
    res.clearCookie('auth', { path: '/', httpOnly: true, sameSite: 'lax' });
    return res.redirect('/');
  }

  try {
    const [rows] = await pool.execute('SELECT is_active FROM users WHERE id = ?', [session.userId]);
    if (rows.length !== 1 || Number(rows[0].is_active) !== 1) {
      sessions.delete(token);
      res.clearCookie('auth', { path: '/', httpOnly: true, sameSite: 'lax' });
      return res.redirect('/');
    }

    session.lastActivity = now;
    sessions.set(token, session);
    req.session = session;
    res.locals.currentUser = { id: session.userId, email: session.email, isAdmin: session.isAdmin === true };
    next();
  } catch (error) {
    next(error);
  }
};

const requireAdmin = async (req, res, next) => {
  requireAuth(req, res, async () => {
    try {
      const [rows] = await pool.execute('SELECT is_admin FROM users WHERE id = ?', [req.session.userId]);
      const isAdmin = rows.length === 1 && Number(rows[0].is_admin) === 1;
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

app.use(['/Crud', '/imei', '/ubicaciones', '/inicio', '/telefono', '/api/telefono'], requireAuth);





app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    // 1. Basic validation
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        // 2. Safely query the user using prepared statements to avoid SQL Injection
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
        
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Invalid email credentials.' });
        }

        const user = rows[0];

        // Passwords must have been migrated to bcrypt before they can be used.
        const isMatch = await verifyPassword(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid password credentials.' });
        }

        // 4. Success handling (Here, you would typically issue a session or JWT)
        return res.status(200).json({
            message: 'Login successful!',
            user: { id: user.id, email: user.email }
            
        });

} catch (error) {
        // This prints the exact file, line number, and error cause to your Node terminal
        console.error('--- CRITICAL ERROR DIAGNOSTIC ---');
        console.error(error.stack || error);
        console.error('---------------------------------');
        
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

app.post('/login', async (req, res) => {
    const { email, password, rememberMe } = req.body;

    if (!email || !password) {
        return res.render('index', { error: 'Email and password are required.', success: null });
    }

    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
        if (rows.length === 0) {
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        const user = rows[0];
        const isMatch = await verifyPassword(password, user.password);

        if (!isMatch) {
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        const authToken = crypto.randomBytes(24).toString('hex');
        const shouldRemember = rememberMe === 'on';
        sessions.set(authToken, {
          userId: user.id,
          email: user.email,
          isAdmin: Number(user.is_admin) === 1,
          rememberMe: shouldRemember,
          lastActivity: Date.now()
        });
        res.cookie('auth', authToken, buildSessionCookieOptions(shouldRemember));

        return res.redirect('/Crud');
    } catch (error) {
        console.error(error.stack || error);
        return res.render('index', { error: 'Internal server error.', success: null });
    }
});

app.get('/logout', (req, res) => {
  const token = getAuthToken(req);
  if (token) {
    sessions.delete(token);
  }

  res.clearCookie('auth', { path: '/', httpOnly: true, sameSite: 'lax' });
  res.setHeader('Set-Cookie', 'auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  return res.redirect('/');
});

// Carga la página de inicio
app.get("/", (req, res) => {
  res.render("index", { error: null, success: null });
});

app.get('/inicio', (req, res) => {
  res.render('inicio');
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const generateSecurePassword = () => crypto.randomBytes(24).toString('base64url');

const renderUsersPage = async (res, { message = null, error = null, generatedPassword = null } = {}) => {
  const [users] = await pool.execute('SELECT id, email, is_admin, is_active, is_initial_admin FROM users ORDER BY email ASC');
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
    const [entries] = await pool.execute(
      `SELECT user_email, method, request_path, status_code, ip_address,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM audit_logs
       ORDER BY id DESC
       LIMIT 200`,
    );
    return res.render('pages/auditoria', { entries });
  } catch (error) {
    next(error);
  }
});

app.post('/usuarios', requireAdmin, async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return renderUsersPage(res, { error: 'Ingresa un correo electrónico válido.' }).catch(next);
  }

  const generatedPassword = generateSecurePassword();
  try {
    const passwordHash = await hashPassword(generatedPassword);
    await pool.execute('INSERT INTO users (email, password, is_admin) VALUES (?, ?, 0)', [email, passwordHash]);
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
    const [result] = await pool.execute('UPDATE users SET password = ? WHERE id = ?', [passwordHash, userId]);
    if (result.affectedRows !== 1) return res.status(404).redirect('/usuarios?error=Usuario%20no%20encontrado.');
    return renderUsersPage(res, { message: 'Contraseña restablecida. Cópiala antes de salir de esta página.', generatedPassword });
  } catch (error) {
    return next(error);
  }
});

app.post('/usuarios/:id/rol', requireAdmin, async (req, res, next) => {
  const userId = Number.parseInt(req.params.id, 10);
  const isAdmin = req.body.isAdmin === '1';
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).redirect('/usuarios?error=Usuario%20inválido.');
  if (userId === req.session.userId && !isAdmin) return res.redirect('/usuarios?error=No%20puedes%20quitarte%20tu%20propio%20acceso%20de%20administrador.');

  try {
    if (!isAdmin) {
      const [[{ adminCount }]] = await pool.execute('SELECT COUNT(*) AS adminCount FROM users WHERE is_admin = 1');
      if (Number(adminCount) <= 1) return res.redirect('/usuarios?error=Debe%20existir%20al%20menos%20un%20administrador.');
    }

    const [result] = await pool.execute('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, userId]);
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
const MKCERT_KEY = path.resolve('./localhost+2-key.pem');
const MKCERT_CERT = path.resolve('./localhost+2.pem');
const CERT_KEY_PATH = fs.existsSync(MKCERT_KEY) ? MKCERT_KEY : path.join(CERT_DIR, 'server.key');
const CERT_CERT_PATH = fs.existsSync(MKCERT_CERT) ? MKCERT_CERT : path.join(CERT_DIR, 'server.crt');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3600);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

const ensureLocalCerts = () => {
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }

  if (!fs.existsSync(CERT_KEY_PATH) || !fs.existsSync(CERT_CERT_PATH)) {
    if (fs.existsSync(MKCERT_KEY) && fs.existsSync(MKCERT_CERT)) {
      fs.copyFileSync(MKCERT_KEY, path.join(CERT_DIR, 'server.key'));
      fs.copyFileSync(MKCERT_CERT, path.join(CERT_DIR, 'server.crt'));
      console.log('Copied mkcert certificates to:', CERT_DIR);
    } else {
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

      fs.writeFileSync(path.join(CERT_DIR, 'server.key'), pems.private);
      fs.writeFileSync(path.join(CERT_DIR, 'server.crt'), pems.cert);
      console.log('Certificados HTTPS generados en:', CERT_DIR);
    }
  }
};

ensureLocalCerts();

const httpsOptions = {
  key: fs.readFileSync(CERT_KEY_PATH),
  cert: fs.readFileSync(CERT_CERT_PATH),
};

const httpsServer = https.createServer(httpsOptions, app);
httpsServer.listen(HTTPS_PORT, HOST, () => {
  console.log(`Servidor HTTPS local en https://127.0.0.1:${HTTPS_PORT}`);
});


startImeiMetadataDailyJob((result) => {
  if (result && result.error) {
    console.log('Error en la revisión diaria de IMEI:', result.error);
  } else if (result && result.processed) {
    console.log(`Revisión diaria de IMEI completada: ${result.processed} registros revisados, ${result.updated} actualizados`);
  }
});
