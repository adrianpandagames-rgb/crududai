import "dotenv/config";
import bcrypt from 'bcrypt';
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

const getAuthToken = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookiePairs = cookieHeader.split(';').map((part) => part.trim());
  const authCookie = cookiePairs.find((cookie) => cookie.startsWith('auth='));
  return authCookie ? authCookie.slice('auth='.length) : null;
};

const requireAuth = (req, res, next) => {
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

  session.lastActivity = now;
  sessions.set(token, session);
  next();
};

app.use(['/Crud', '/imei', '/ubicaciones', '/inicio'], requireAuth);





app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    // 1. Basic validation
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    try {
        // 2. Safely query the user using prepared statements to avoid SQL Injection
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Invalid email credentials.' });
        }

        const user = rows[0];

       // 3. Verify submitted password against stored password.
        // Allow plain-text stored passwords for now, but use bcrypt hashes when available.
        const storedPassword = user.password || '';
        const isHashed = storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$');
        const isMatch = isHashed
            ? await bcrypt.compare(password, storedPassword)
            : password === storedPassword;

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
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) {
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        const user = rows[0];
        const storedPassword = user.password || '';
        const isHashed = storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$');
        const isMatch = isHashed
            ? await bcrypt.compare(password, storedPassword)
            : password === storedPassword;

        if (!isMatch) {
            return res.render('index', { error: 'Invalid credentials.', success: null });
        }

        const authToken = crypto.randomBytes(24).toString('hex');
        const shouldRemember = rememberMe === 'on';
        sessions.set(authToken, {
          userId: user.id,
          email: user.email,
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
  console.log(`Servidor HTTPS en ejecución en https://${HOST}:${HTTPS_PORT}`);
  console.log(`Servidor HTTPS local en https://127.0.0.1:${HTTPS_PORT}`);
});

const httpServer = http.createServer({ maxHeaderSize: 128 * 1024 }, (req, res) => {
  const host = req.headers.host?.split(':')[0] || '127.0.0.1';
  res.writeHead(301, {
    Location: `https://${host}:${HTTPS_PORT}${req.url}`,
  });
  res.end();
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Servidor HTTP en ejecución en http://${HOST}:${PORT}`);
  console.log(`Servidor HTTP local en http://127.0.0.1:${PORT}`);
});

startImeiMetadataDailyJob((result) => {
  if (result && result.error) {
    console.log('Error en la revisión diaria de IMEI:', result.error);
  } else if (result && result.processed) {
    console.log(`Revisión diaria de IMEI completada: ${result.processed} registros revisados, ${result.updated} actualizados`);
  }
});
