import express from 'express';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { requireSameOrigin } from './requestSecurity.js';
import {
  MAX_INTENTOS_PENDIENTE, MAX_PASSKEYS, PENDIENTE_COOKIE, nombrePasskey, opcionesCookiePendiente,
} from './dosPasosService.js';

const CHALLENGE_MS = 5 * 60 * 1000;

const leerCookie = (req, nombre) => {
  const par = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${nombre}=`));
  return par ? par.slice(nombre.length + 1) : null;
};

// /verificar: the second step of a sign-in whose password was right. Nothing here opens a session by itself;
// `completarLogin(req, res, pendiente, metodo)` (app.js, which owns the sessions) does, and returns where to go,
// or null when the account changed meanwhile (disabled, or its password changed).
// `registrarFallo(req, pendiente, motivo)` writes the failed attempt to the audit log and the rate limiter.
export function createVerificacionRouter({ store, pendientes, config, completarLogin, registrarFallo, esperaMs }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') return requireSameOrigin(req, res, next);
    return next();
  });

  const pendienteDe = (req) => pendientes.obtener(leerCookie(req, PENDIENTE_COOKIE));
  const terminar = (req, res) => {
    pendientes.quitar(leerCookie(req, PENDIENTE_COOKIE));
    res.clearCookie(PENDIENTE_COOKIE, { ...opcionesCookiePendiente(), maxAge: undefined });
  };
  const pagina = (res, status, { error = null } = {}) => res.status(status).render('pages/verificar', {
    error, passkeysDisponibles: Boolean(config),
  });
  const bloqueado = (req, pendiente) => {
    const ms = esperaMs(req, pendiente);
    return ms > 0 ? `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(ms / 60000)} minuto(s).` : null;
  };

  // Every wrong attempt counts; after the fifth the password has to be typed again.
  const fallo = (req, res, pendiente, motivo) => {
    pendiente.intentos += 1;
    registrarFallo(req, pendiente, motivo);
    if (pendiente.intentos >= MAX_INTENTOS_PENDIENTE) {
      terminar(req, res);
      return { agotado: true, error: 'Demasiados intentos. Vuelve a iniciar sesión.' };
    }
    return { agotado: false, error: motivo };
  };

  const completar = async (req, res, pendiente, metodo) => {
    terminar(req, res);
    return completarLogin(req, res, pendiente, metodo);
  };

  router.get('/', (req, res) => {
    if (!pendienteDe(req)) return res.redirect('/');
    return pagina(res, 200);
  });

  router.post('/opciones', async (req, res, next) => {
    const pendiente = pendienteDe(req);
    if (!pendiente) return res.status(401).json({ error: 'La verificación expiró. Vuelve a iniciar sesión.', redirect: '/' });
    if (!config) return res.status(503).json({ error: 'Las llaves de acceso no están configuradas en este servidor. Usa un código de recuperación.' });
    try {
      const credenciales = await store.credenciales(pendiente.userId);
      const options = await generateAuthenticationOptions({
        rpID: config.rpID,
        allowCredentials: credenciales.map(({ id, transports }) => ({ id, transports })),
        userVerification: 'required',
      });
      pendiente.challenge = options.challenge;
      return res.json(options);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/passkey', async (req, res, next) => {
    const pendiente = pendienteDe(req);
    if (!pendiente) return res.status(401).json({ error: 'La verificación expiró. Vuelve a iniciar sesión.', redirect: '/' });
    const espera = bloqueado(req, pendiente);
    if (espera) return res.status(429).json({ error: espera });
    const challenge = pendiente.challenge;
    // A challenge is good for one answer.
    pendiente.challenge = null;
    const respuesta = req.body?.respuesta;
    // The signed answer is not useful in the audit log.
    req.body = {};
    try {
      const credencial = challenge && config && respuesta?.id
        ? (await store.credenciales(pendiente.userId)).find(({ id }) => id === respuesta.id) : null;
      let verificada = null;
      if (credencial) {
        verificada = await verifyAuthenticationResponse({
          response: respuesta,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpID,
          credential: credencial,
          requireUserVerification: true,
        }).catch(() => null);
      }
      if (!verificada?.verified) {
        const { agotado, error } = fallo(req, res, pendiente, 'No se pudo verificar la llave de acceso.');
        return res.status(401).json({ error, ...(agotado ? { redirect: '/' } : {}) });
      }
      await store.registrarUso(pendiente.userId, credencial.id, verificada.authenticationInfo.newCounter);
      const destino = await completar(req, res, pendiente, 'Llave de acceso');
      return res.json({ redirect: destino || '/' });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/codigo', async (req, res, next) => {
    const pendiente = pendienteDe(req);
    if (!pendiente) return res.redirect(303, '/');
    const espera = bloqueado(req, pendiente);
    if (espera) return pagina(res, 429, { error: espera });
    const codigo = String(req.body?.codigo || '');
    req.body = {};
    try {
      if (!await store.usarCodigo(pendiente.userId, codigo)) {
        const { agotado, error } = fallo(req, res, pendiente, 'El código de recuperación no es válido o ya se usó.');
        return agotado ? res.status(401).render('index', { error, success: null }) : pagina(res, 401, { error });
      }
      const destino = await completar(req, res, pendiente, 'Código de recuperación');
      return res.redirect(303, destino || '/');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/cancelar', (req, res) => {
    terminar(req, res);
    return res.redirect(303, '/');
  });

  return router;
}

// /cuenta/dos-pasos: the person adds and removes their own passkeys and recovery codes. Mounted behind
// requireAuth; it only touches req.session.userId. Removing a passkey or replacing the codes asks for the
// password: `confirmarContrasena(req, password)` returns an error message, or null when it is right.
// With `obligatorio` the last passkey cannot be removed: the person adds another first.
export function createDosPasosCuentaRouter({ store, config, confirmarContrasena, avisar = () => {}, obligatorio = false }) {
  const router = express.Router();

  const volver = (req, res, flash) => {
    req.session.flash = flash;
    return res.redirect(303, '/cuenta#dos-pasos');
  };

  router.use((req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    return next();
  });

  router.post('/opciones', async (req, res, next) => {
    if (!config) return res.status(503).json({ error: 'Las llaves de acceso no están configuradas en este servidor (falta PUBLIC_BASE_URL con el dominio).' });
    try {
      const credenciales = await store.credenciales(req.session.userId);
      if (credenciales.length >= MAX_PASSKEYS) {
        return res.status(400).json({ error: `Ya tienes ${MAX_PASSKEYS} llaves de acceso. Quita una para agregar otra.` });
      }
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userName: req.session.email,
        userDisplayName: req.session.email,
        attestationType: 'none',
        excludeCredentials: credenciales.map(({ id, transports }) => ({ id, transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      req.session.registroDosPasos = { challenge: options.challenge, expira: Date.now() + CHALLENGE_MS };
      return res.json(options);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    const registro = req.session.registroDosPasos;
    delete req.session.registroDosPasos;
    const respuesta = req.body?.respuesta;
    const nombre = nombrePasskey(req.body?.nombre);
    // The audit log keeps the device name, not the signed answer.
    req.body = { nombre };
    if (!config || !registro || registro.expira < Date.now() || !respuesta) {
      return res.status(400).json({ error: 'La solicitud expiró. Intenta de nuevo.' });
    }
    try {
      const verificada = await verifyRegistrationResponse({
        response: respuesta,
        expectedChallenge: registro.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      }).catch(() => null);
      if (!verificada?.verified) return res.status(400).json({ error: 'No se pudo registrar la llave de acceso.' });
      const eraPrimera = !await store.activo(req.session.userId);
      const { credential } = verificada.registrationInfo;
      await store.guardar(req.session.userId, { ...credential, nombre });
      // This session may now use the app, if the second step is required.
      req.session.dosPasosActivo = true;
      const codigos = eraPrimera ? await store.nuevosCodigos(req.session.userId) : null;
      avisar(req.session.userId, {
        title: 'Verificación en dos pasos',
        message: `Se agregó la llave de acceso «${nombre}» a tu cuenta. Si no fuiste tú, avisa de inmediato al administrador.`,
        url: '/cuenta#dos-pasos',
      });
      req.session.flash = {
        message: eraPrimera
          ? 'Verificación en dos pasos activada. Guarda tus códigos de recuperación.'
          : `Llave de acceso «${nombre}» agregada.`,
        codigos,
      };
      return res.json({ redirect: '/cuenta#dos-pasos' });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Esa llave de acceso ya está registrada.' });
      return next(error);
    }
  });

  router.post('/:id/eliminar', async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return volver(req, res, { error: 'Llave de acceso inválida.' });
    try {
      if (obligatorio && (await store.credenciales(req.session.userId)).length <= 1) {
        return volver(req, res, { error: 'La verificación en dos pasos es obligatoria: agrega otra llave de acceso antes de quitar la última.' });
      }
      const error = await confirmarContrasena(req, String(req.body?.currentPassword || ''));
      if (error) return volver(req, res, { error });
      const { eliminada, quedan } = await store.eliminar(req.session.userId, Number(req.params.id));
      if (!eliminada) return volver(req, res, { error: 'Llave de acceso no encontrada.' });
      avisar(req.session.userId, {
        title: 'Verificación en dos pasos',
        message: quedan ? 'Se quitó una llave de acceso de tu cuenta.' : 'Se desactivó la verificación en dos pasos de tu cuenta.',
        url: '/cuenta#dos-pasos',
      });
      return volver(req, res, {
        message: quedan ? 'Llave de acceso quitada.' : 'Llave de acceso quitada. La verificación en dos pasos quedó desactivada.',
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/codigos', async (req, res, next) => {
    try {
      if (!await store.activo(req.session.userId)) return volver(req, res, { error: 'Primero agrega una llave de acceso.' });
      const error = await confirmarContrasena(req, String(req.body?.currentPassword || ''));
      if (error) return volver(req, res, { error });
      const codigos = await store.nuevosCodigos(req.session.userId);
      return volver(req, res, { message: 'Códigos nuevos generados. Los anteriores ya no sirven.', codigos });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
