import express from 'express';
import multer from 'multer';
import {
  MAX_FOTO_BYTES, MAX_NOMBRE_LENGTH, createCuentaStore, normalizarPreferencias, paginasInicioPara, procesarFoto, temas, validarNombre,
} from './cuentaService.js';
import { createNotificacionesStore } from './notificacionesService.js';
import { createTablasStore, normalizarConfigTabla, tablaValida } from './tablasService.js';

// Each person's own page: name, photo, password, preferences and notifications. It only ever reads or writes
// req.session.userId, so nobody can reach another person's account through it.
// `cambiarContrasena(req, res, { actual, nueva })` lives in app.js, which owns the sessions it has to rotate.
export function createCuentaRouter(pool, {
  cuentas = createCuentaStore(pool), notificaciones = createNotificacionesStore(pool), tablas = createTablasStore(pool),
  cambiarContrasena, dosPasos = null, dosPasosDisponible = false, dosPasosObligatorio = false,
} = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FOTO_BYTES, files: 1, fields: 2 } }).single('foto');

  // Results travel in the session, like the admin forms, so nobody can write a message into a link.
  const volver = (req, res, path, flash) => {
    req.session.flash = flash;
    return res.redirect(303, path);
  };
  const takeFlash = (req) => {
    const flash = req.session.flash || {};
    delete req.session.flash;
    // Recovery codes are shown once, right after they are made, and never kept anywhere readable.
    return { message: flash.message || null, error: flash.error || null, codigos: flash.codigos || null };
  };

  router.use((req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res, next) => {
    try {
      const [cuenta, passkeys, codigosRestantes] = await Promise.all([
        cuentas.get(req.session.userId, req.session.role),
        dosPasos ? dosPasos.listar(req.session.userId) : [],
        dosPasos ? dosPasos.codigosRestantes(req.session.userId) : 0,
      ]);
      return res.render('pages/cuenta', {
        ...takeFlash(req), cuenta, passkeys, codigosRestantes, dosPasosDisponible, dosPasosObligatorio, email: req.session.email, temas, paginasInicio: paginasInicioPara(req.session.role),
        MAX_NOMBRE_LENGTH, maxFotoMb: MAX_FOTO_BYTES / 1024 / 1024,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/nombre', async (req, res, next) => {
    const { nombre, error } = validarNombre(req.body.nombre);
    if (error) return volver(req, res, '/cuenta', { error });
    try {
      await cuentas.setNombre(req.session.userId, nombre);
      return volver(req, res, '/cuenta', { message: nombre ? 'Nombre actualizado.' : 'Se quitó tu nombre; se mostrará tu correo.' });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/foto', (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    return volver(req, res, '/cuenta', {
      error: error.code === 'LIMIT_FILE_SIZE' ? `La foto supera el límite de ${MAX_FOTO_BYTES / 1024 / 1024} MB.` : 'No fue posible leer la foto enviada.',
    });
  }), async (req, res, next) => {
    if (!req.file) return volver(req, res, '/cuenta', { error: 'Elige una foto.' });
    const { data, error } = await procesarFoto(req.file.buffer);
    if (error) return volver(req, res, '/cuenta', { error });
    try {
      await cuentas.setFoto(req.session.userId, data);
      return volver(req, res, '/cuenta', { message: 'Foto actualizada.' });
    } catch (saveError) {
      return next(saveError);
    }
  });

  router.post('/foto/eliminar', async (req, res, next) => {
    try {
      await cuentas.setFoto(req.session.userId, null);
      return volver(req, res, '/cuenta', { message: 'Foto eliminada.' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/foto', async (req, res, next) => {
    try {
      const foto = await cuentas.getFoto(req.session.userId);
      if (!foto) return res.status(404).send('Sin foto.');
      // The URL carries the photo's version, so it can be cached until the person changes it.
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(foto);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/contrasena', async (req, res, next) => {
    // Every field name contains "password", so the audit log hides their values.
    const actual = String(req.body.currentPassword || '');
    const nueva = String(req.body.password || '');
    if (nueva.length < 8) return volver(req, res, '/cuenta#contrasena', { error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    if (nueva !== String(req.body.confirmPassword || '')) return volver(req, res, '/cuenta#contrasena', { error: 'Las contraseñas no coinciden.' });
    if (nueva === actual) return volver(req, res, '/cuenta#contrasena', { error: 'La nueva contraseña debe ser distinta de la actual.' });
    try {
      // On success the session was rotated, so the flash goes on the new one that cambiarContrasena left in req.session.
      const { error, warning, ended } = await cambiarContrasena(req, res, { actual, nueva });
      if (ended) return res.redirect(303, '/');
      if (error) return volver(req, res, '/cuenta#contrasena', { error });
      return volver(req, res, '/cuenta#contrasena', { message: 'Contraseña actualizada.', error: warning || null });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/preferencias', async (req, res, next) => {
    const preferencias = normalizarPreferencias({
      tema: req.body.tema, inicio: req.body.inicio, avisos: req.body.avisos === '1',
    }, req.session.role);
    try {
      await cuentas.setPreferencias(req.session.userId, preferencias);
      return volver(req, res, '/cuenta#preferencias', { message: 'Preferencias guardadas.' });
    } catch (error) {
      return next(error);
    }
  });

  // The theme button on every page saves the choice here, so it follows the person to other devices.
  router.post('/tema', async (req, res, next) => {
    const tema = { light: 'claro', dark: 'oscuro' }[req.body?.tema];
    if (!tema) return res.status(400).json({ error: 'Tema inválido.' });
    try {
      const { preferencias } = await cuentas.get(req.session.userId, req.session.role);
      await cuentas.setPreferencias(req.session.userId, { ...preferencias, tema });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  // How each table looks for this person (public/js/tablas.js): every table at once, and one at a time on change.
  router.get('/tablas', async (req, res, next) => {
    try {
      return res.json(await tablas.listar(req.session.userId));
    } catch (error) {
      return next(error);
    }
  });

  router.put('/tablas', async (req, res, next) => {
    const tabla = req.body?.tabla;
    if (!tablaValida(tabla)) return res.status(400).json({ error: 'Tabla inválida.' });
    try {
      await tablas.guardar(req.session.userId, tabla, normalizarConfigTabla(req.body.config));
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/notificaciones', async (req, res, next) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const soloNoLeidas = req.query.filtro === 'no-leidas';
    try {
      return res.render('pages/notificaciones', {
        ...takeFlash(req), ...await notificaciones.listar(req.session.userId, { page, soloNoLeidas }), soloNoLeidas,
      });
    } catch (error) {
      return next(error);
    }
  });

  // Opening a notice marks it read and follows its link, when it has one.
  router.post('/notificaciones/:id/abrir', async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return volver(req, res, '/cuenta/notificaciones', { error: 'Notificación inválida.' });
    try {
      const result = await notificaciones.marcarLeida(req.params.id, req.session.userId);
      if (!result) return volver(req, res, '/cuenta/notificaciones', { error: 'Notificación no encontrada.' });
      return res.redirect(303, result.url || '/cuenta/notificaciones');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/notificaciones/leer-todas', async (req, res, next) => {
    try {
      await notificaciones.marcarTodas(req.session.userId);
      return volver(req, res, '/cuenta/notificaciones', { message: 'Todas las notificaciones quedaron como leídas.' });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/notificaciones/eliminar-leidas', async (req, res, next) => {
    try {
      await notificaciones.eliminarLeidas(req.session.userId);
      return volver(req, res, '/cuenta/notificaciones', { message: 'Notificaciones leídas eliminadas.' });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
