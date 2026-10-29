import express from 'express';
import multer from 'multer';
import path from 'node:path';
import {
  MAX_IMAGES_PER_PERFIL, createPerfilesStore, extractTitular, perfilImageType, readXlsxSheets, titularHasNoRecord, validarPerfil,
} from './perfilesService.js';
import { parsePagination } from './routeHelpers.js';

const MAX_IMAGES_PER_UPLOAD = 10;

export function createPerfilesRouter(pool, { perfiles = createPerfilesStore(pool) } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } }).single('archivo');
  const uploadImages = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: MAX_IMAGES_PER_UPLOAD } })
    .array('imagenes', MAX_IMAGES_PER_UPLOAD);
  // Row forms send the list's search and page back in a hidden "volver" field, so an action returns to the same place.
  // Takes that field's query string, or the edit page's req.query, and keeps only the list's own parameters.
  const returnQuery = (value) => {
    const back = new URLSearchParams(typeof value === 'string' || (value && typeof value === 'object') ? value : '');
    return Object.fromEntries(['search', 'page', 'pageSize'].filter((key) => back.get(key)).map((key) => [key, back.get(key).slice(0, 100)]));
  };
  const volverOf = (value) => new URLSearchParams(returnQuery(value)).toString();
  // With a profile id the list scrolls to that row and opens its photos.
  const redirect = (res, message, type = 'error', { req, perfilId } = {}) => res.redirect('/perfiles?' + new URLSearchParams({
    ...returnQuery(req?.body?.volver), ...(perfilId ? { abierto: String(perfilId) } : {}), message, type,
  }) + (perfilId ? `#perfil-${perfilId}` : ''));

  router.use((req, res, next) => {
    if (!req.session?.userId) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // The list with its search and page; extra carries the form and message of the page being rendered.
  const renderList = async (req, res, extra, status = 200) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const { page, pageSize } = parsePagination(req.query);
    const { rows, total } = await perfiles.list(req.session, { search, page, pageSize });
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    if (!rows.length && page > totalPages) {
      return res.redirect('/perfiles?' + new URLSearchParams({ ...req.query, page: String(totalPages) }));
    }
    return res.status(status).render('pages/perfiles', {
      perfiles: rows, total, search, currentPage: page, totalPages, pageSize, abierto: String(req.query.abierto ?? ''), formError: null, ...extra,
    });
  };
  const formOf = (body = {}) => ({ nombre: body.nombre, direccion: body.direccion, alias: body.alias, linea: body.linea });
  // Registration errors render the list again with what was typed, instead of redirecting and losing it.
  const failCreate = (req, res, message, field = 'archivo') => renderList(req, res, {
    form: formOf(req.body), message: '', formError: { message, field },
  }, 400);

  router.get('/', async (req, res, next) => {
    try {
      await renderList(req, res, {
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
    return failCreate(req, res, error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 20 MB.' : 'No fue posible leer el archivo enviado.')
      .catch(next);
  }), async (req, res, next) => {
    const form = formOf(req.body);
    let note = '';
    if (req.file) {
      if (path.extname(req.file.originalname).toLowerCase() !== '.xlsx') return failCreate(req, res, 'El archivo debe ser Excel (.xlsx).').catch(next);
      let sheets;
      try {
        sheets = readXlsxSheets(req.file.buffer);
      } catch {
        return failCreate(req, res, 'No fue posible leer el archivo Excel.').catch(next);
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
    const { perfil, error, field } = validarPerfil(form);
    try {
      if (error) {
        return await renderList(req, res, { form, message: '', formError: { message: error + (req.file ? note : ''), field } }, 400);
      }
      const perfilId = await perfiles.create(perfil, req.session);
      return redirect(res, 'Perfil registrado correctamente.' + note, 'success', { perfilId });
    } catch (failure) {
      return next(failure);
    }
  });

  router.get('/:id/editar', async (req, res, next) => {
    try {
      const perfil = /^\d+$/.test(req.params.id) ? await perfiles.get(req.params.id, req.session) : null;
      if (!perfil) return redirect(res, 'El perfil no fue encontrado.');
      return res.render('pages/editar-perfil', { perfil, error: null, volver: volverOf(req.query) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/editar', async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return redirect(res, 'El perfil no fue encontrado.');
    const { perfil, error } = validarPerfil(req.body);
    try {
      if (error) {
        const form = {
          id: req.params.id, nombre: req.body.nombre ?? '', direccion: req.body.direccion ?? '', alias: req.body.alias ?? '', linea: req.body.linea ?? '',
        };
        return res.status(400).render('pages/editar-perfil', { perfil: form, error, volver: volverOf(req.body.volver) });
      }
      const updated = await perfiles.update(req.params.id, perfil, req.session);
      return updated ? redirect(res, 'Perfil actualizado correctamente.', 'success', { req, perfilId: req.params.id })
        : redirect(res, 'El perfil no fue encontrado.', 'error', { req });
    } catch (failure) {
      return next(failure);
    }
  });

  router.post('/:id/imagenes',(req, res, next) => uploadImages(req, res, (error) => {
    if (!error) return next();
    const back = { req, perfilId: /^\d+$/.test(req.params.id) ? req.params.id : null };
    return redirect(res, error.code === 'LIMIT_FILE_SIZE' ? 'Cada imagen puede pesar hasta 10 MB.'
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? `Suba hasta ${MAX_IMAGES_PER_UPLOAD} imágenes a la vez.`
        : 'No fue posible recibir las imágenes.', 'error', back);
  }), async (req, res, next) => {
    const files = req.files || [];
    if (!/^\d+$/.test(req.params.id)) return redirect(res, 'El perfil no fue encontrado.', 'error', { req });
    const back = { req, perfilId: req.params.id };
    if (files.length === 0) return redirect(res, 'Seleccione al menos una imagen.', 'error', back);
    const images = files.map((file) => ({ name: file.originalname, buffer: file.buffer, type: perfilImageType(file.buffer) }));
    const invalid = images.find((image) => !image.type);
    if (invalid) return redirect(res, `${invalid.name} no es una imagen JPG, PNG, GIF o WebP.`, 'error', back);
    try {
      const saved = await perfiles.addImages(req.params.id, images, req.session);
      if (saved === null) return redirect(res, 'El perfil no fue encontrado.', 'error', { req });
      if (saved < images.length) {
        return redirect(res, `Se agregaron ${saved} de ${images.length} imágenes: cada perfil admite hasta ${MAX_IMAGES_PER_PERFIL}.`,
          saved ? 'success' : 'error', back);
      }
      return redirect(res, saved === 1 ? 'Imagen agregada al perfil.' : `Se agregaron ${saved} imágenes al perfil.`, 'success', back);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/imagenes/eliminar', async (req, res, next) => {
    try {
      const removed = /^\d+$/.test(req.params.id) ? await perfiles.removeAllImages(req.params.id, req.session) : null;
      if (removed === null) return redirect(res, 'El perfil no fue encontrado.', 'error', { req });
      return redirect(res, removed === 1 ? 'Se eliminó 1 imagen del perfil.' : `Se eliminaron ${removed} imágenes del perfil.`, 'success',
        { req, perfilId: req.params.id });
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
      const perfilId = /^\d+$/.test(req.params.id) ? await perfiles.removeImage(req.params.id, req.session) : null;
      return perfilId ? redirect(res, 'Imagen eliminada correctamente.', 'success', { req, perfilId })
        : redirect(res, 'La imagen no fue encontrada.', 'error', { req });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/eliminar/:id', async (req, res, next) => {
    try {
      const outcome = /^\d+$/.test(req.params.id) ? await perfiles.remove(req.params.id, req.session) : 'no-encontrado';
      if (outcome === 'eliminado') return redirect(res, 'Perfil eliminado correctamente.', 'success', { req });
      return outcome === 'con-imagenes'
        ? redirect(res, 'El perfil tiene imágenes. Elimínelas primero para poder eliminar el perfil.', 'error', { req, perfilId: req.params.id })
        : redirect(res, 'El perfil no fue encontrado.', 'error', { req });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
