import express from 'express';
import multer from 'multer';
import path from 'node:path';
import {
  MAX_IMAGES_PER_PERFIL, createPerfilesStore, extractTitular, perfilImageType, readXlsxSheets, titularHasNoRecord, validarPerfil,
} from './perfilesService.js';

const MAX_IMAGES_PER_UPLOAD = 10;

export function createPerfilesRouter(pool, { perfiles = createPerfilesStore(pool) } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } }).single('archivo');
  const uploadImages = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: MAX_IMAGES_PER_UPLOAD } })
    .array('imagenes', MAX_IMAGES_PER_UPLOAD);
  const redirect = (res, message, type = 'error') => res.redirect('/perfiles?' + new URLSearchParams({ message, type }));

  router.use((req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res, next) => {
    try {
      res.render('pages/perfiles', {
        perfiles: await perfiles.list(req.session),
        form: {},
        message: typeof req.query.message === 'string' ? req.query.message : '',
        messageType: req.query.type,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    return redirect(res, error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 20 MB.' : 'No fue posible leer el archivo enviado.');
  }), async (req, res, next) => {
    const form = { nombre: req.body.nombre, direccion: req.body.direccion, linea: req.body.linea };
    let note = '';
    if (req.file) {
      if (path.extname(req.file.originalname).toLowerCase() !== '.xlsx') return redirect(res, 'El archivo debe ser Excel (.xlsx).');
      let sheets;
      try {
        sheets = readXlsxSheets(req.file.buffer);
      } catch {
        return redirect(res, 'No fue posible leer el archivo Excel.');
      }
      // The file's Nombre and Dirección win over what was typed, unless the carrier found no record.
      const titular = extractTitular(sheets);
      if (titular) {
        if (titular.nombre) form.nombre = titular.nombre;
        if (titular.direccion) form.direccion = titular.direccion;
        note = ' Se tomaron los datos del archivo.';
      } else {
        note = titularHasNoRecord(sheets)
          ? ' El archivo indica que no se encontró registro de la línea; se usaron los datos escritos.'
          : ' El archivo no tiene filas de Nombre o Dirección; se usaron los datos escritos.';
      }
    }
    const { perfil, error } = validarPerfil(form);
    try {
      if (error) {
        return res.status(400).render('pages/perfiles', {
          perfiles: await perfiles.list(req.session), form, message: error + (req.file ? note : ''), messageType: 'error',
        });
      }
      await perfiles.create(perfil, req.session);
      return redirect(res, 'Perfil registrado correctamente.' + note, 'success');
    } catch (failure) {
      return next(failure);
    }
  });

  router.get('/:id/editar', async (req, res, next) => {
    try {
      const perfil = /^\d+$/.test(req.params.id) ? await perfiles.get(req.params.id, req.session) : null;
      if (!perfil) return redirect(res, 'El perfil no fue encontrado.');
      return res.render('pages/editar-perfil', { perfil, error: null });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/editar', async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return redirect(res, 'El perfil no fue encontrado.');
    const { perfil, error } = validarPerfil(req.body);
    try {
      if (error) {
        const form = { id: req.params.id, nombre: req.body.nombre ?? '', direccion: req.body.direccion ?? '', linea: req.body.linea ?? '' };
        return res.status(400).render('pages/editar-perfil', { perfil: form, error });
      }
      const updated = await perfiles.update(req.params.id, perfil, req.session);
      return updated ? redirect(res, 'Perfil actualizado correctamente.', 'success') : redirect(res, 'El perfil no fue encontrado.');
    } catch (failure) {
      return next(failure);
    }
  });

  router.post('/:id/imagenes',(req, res, next) => uploadImages(req, res, (error) => {
    if (!error) return next();
    return redirect(res, error.code === 'LIMIT_FILE_SIZE' ? 'Cada imagen puede pesar hasta 10 MB.'
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? `Sube hasta ${MAX_IMAGES_PER_UPLOAD} imágenes a la vez.`
        : 'No fue posible recibir las imágenes.');
  }), async (req, res, next) => {
    const files = req.files || [];
    if (!/^\d+$/.test(req.params.id)) return redirect(res, 'El perfil no fue encontrado.');
    if (files.length === 0) return redirect(res, 'Selecciona al menos una imagen.');
    const images = files.map((file) => ({ name: file.originalname, buffer: file.buffer, type: perfilImageType(file.buffer) }));
    const invalid = images.find((image) => !image.type);
    if (invalid) return redirect(res, `${invalid.name} no es una imagen JPG, PNG, GIF o WebP.`);
    try {
      const saved = await perfiles.addImages(req.params.id, images, req.session);
      if (saved === null) return redirect(res, 'El perfil no fue encontrado.');
      if (saved < images.length) {
        return redirect(res, `Se agregaron ${saved} de ${images.length} imágenes: cada perfil admite hasta ${MAX_IMAGES_PER_PERFIL}.`, saved ? 'success' : 'error');
      }
      return redirect(res, saved === 1 ? 'Imagen agregada al perfil.' : `Se agregaron ${saved} imágenes al perfil.`, 'success');
    } catch (error) {
      return next(error);
    }
  });

  router.get('/imagenes/:id', async (req, res, next) => {
    try {
      const image = /^\d+$/.test(req.params.id) ? await perfiles.getImage(req.params.id, req.session) : null;
      if (!image) return res.status(404).send('Imagen no encontrada.');
      res.setHeader('Content-Type', image.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(image.data);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/imagenes/:id/eliminar', async (req, res, next) => {
    try {
      const removed = /^\d+$/.test(req.params.id) && await perfiles.removeImage(req.params.id, req.session);
      return removed ? redirect(res, 'Imagen eliminada correctamente.', 'success') : redirect(res, 'La imagen no fue encontrada.');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/eliminar/:id', async (req, res, next) => {
    try {
      const outcome = /^\d+$/.test(req.params.id) ? await perfiles.remove(req.params.id, req.session) : 'no-encontrado';
      if (outcome === 'eliminado') return redirect(res, 'Perfil eliminado correctamente.', 'success');
      return redirect(res, outcome === 'con-imagenes'
        ? 'El perfil tiene imágenes. Elimínalas primero con su botón para poder eliminar el perfil.'
        : 'El perfil no fue encontrado.');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
