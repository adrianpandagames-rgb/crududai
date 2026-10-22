import express from "express";
import multer from "multer";
import { forwardAsyncErrors } from './errorHandling.js';
import { requireRecordCreator, requireRecordEditor } from './recordPermissions.js';
import {
  agregarEstudiante,
  listarEstudiantes,
  obtenerOCrearObjetivo,
  agregarContacto,
  registrarLineaSinUtilidad,
  contactoExisteExacto,
  contactoCoincidenciasParciales,
  buscarObjetivoEnObjetivoImei,
  verificarObjetivoConContactos,
  obtenerObjetivoPorId,
  actualizarObjetivo,
} from "./estudianteController.js";
import { parseCsvRow } from './csvUtils.js';
import { MAX_REDIRECT_ITEMS, parsePagination } from './routeHelpers.js';

const CONTACTS_MAX_FILE_SIZE = 5 * 1024 * 1024;
const CONTACTS_MAX_ROWS = 10000;
const uploadStorage = multer.memoryStorage();
const upload = multer({ storage: uploadStorage, limits: { fileSize: CONTACTS_MAX_FILE_SIZE, files: 1, fields: 10, parts: 11, fieldSize: 4096 } });
const router = forwardAsyncErrors(express.Router());

router.get('/lineas/editar/:id', requireRecordEditor, async (req, res) => {
  const idObjetivo = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(idObjetivo) || idObjetivo < 1) return res.status(400).send('Línea inválida.');
  const objetivo = await obtenerObjetivoPorId(idObjetivo);
  if (!objetivo) return res.status(404).send('Línea no encontrada.');
  return res.render('pages/editar-linea', { objetivo, error: null });
});

router.post('/lineas/editar/:id', requireRecordEditor, async (req, res) => {
  const idObjetivo = Number.parseInt(req.params.id, 10);
  const objetivo = {
    idObjetivo,
    numObjetivo: String(req.body.numObjetivo || '').trim(),
    nuc: String(req.body.nuc || '').trim(),
    delito: String(req.body.delito || '').trim(),
    tipo: String(req.body.tipo || '').trim(),
    ano: String(req.body.ano || '').trim(),
  };
  if (!Number.isSafeInteger(idObjetivo) || idObjetivo < 1 || !objetivo.numObjetivo || !objetivo.nuc || !objetivo.tipo || objetivo.delito.length > 255 || !/^\d{4}$/.test(objetivo.ano)) {
    return res.status(400).render('pages/editar-linea', { objetivo, error: 'Completa todos los campos con valores válidos.' });
  }
  try {
    const updated = await actualizarObjetivo(idObjetivo, objetivo);
    if (!updated) return res.status(404).send('Línea no encontrada.');
    return res.redirect('/Crud?message=' + encodeURIComponent('Línea actualizada correctamente.') + '&type=success');
  } catch (error) {
    return res.status(500).render('pages/editar-linea', { objetivo, error: 'No fue posible actualizar la línea.' });
  }
});

router.get("/Crud", async (req, res, next) => {
  try {
    const searchTerm = req.query.numObjetivo || req.query.search || "";
    const { page, pageSize } = parsePagination(req.query);

    const { rows: objetivos, total } = await listarEstudiantes(searchTerm, page, pageSize);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const startIndex = (page - 1) * pageSize + 1;

    let objectiveImeiMatches = [];
    if (searchTerm) {
      const nucObjetivo = req.query.nucObjetivo || "";
      const ano = req.query.ano || "";
      objectiveImeiMatches = await buscarObjetivoEnObjetivoImei(searchTerm, nucObjetivo, ano);
    }

    if (req.query.fragment === '1') {
      return res.render('partials/contactos-results', {
        objetivos,
        searchTerm,
        currentPage: page,
        totalPages,
        startIndex,
        pageSize,
      });
    }

    res.render("pages/estudiantes", {
      objetivos,
      searchTerm,
      objectiveImeiMatches,
      message: req.query.message || null,
      messageType: req.query.type || null,
      currentPage: page,
      totalPages,
      startIndex,
      pageSize,
    });
  } catch (error) {
    return next(error);
  }
});

const contactsUpload = (req, res, next) => {
  upload.single('csvFile')(req, res, (error) => {
    if (!error) return next();
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      status: 'error',
      message: error.code === 'LIMIT_FILE_SIZE' ? 'El CSV supera el límite de 5 MB.' : 'La carga CSV supera los límites permitidos o tiene campos inválidos.',
    });
  });
};

router.post('/Crud/import-csv', requireRecordCreator, contactsUpload, async (req, res) => {
  try {
    const delito = String(req.body.delito || '').trim();
    if (delito.length > 255) {
      return res.status(400).json({ status: 'error', message: 'Delito debe tener como máximo 255 caracteres.' });
    }
    if (req.body.sinUtilidad === 'true') {
      const { numObjetivo, nucObjetivo, curso_dc, ano } = req.body;
      if (!numObjetivo?.trim() || !nucObjetivo?.trim() || !curso_dc || !ano) {
        return res.json({ status: 'error', message: 'Línea, NUC, año y curso son requeridos.' });
      }
      if (req.query.validateOnly === 'true' || req.body.validateOnly === 'true') {
        return res.json({ status: 'ready' });
      }
      await registrarLineaSinUtilidad(numObjetivo.trim(), nucObjetivo.trim(), curso_dc, ano, delito);
      const message = 'Línea registrada con contacto sin utilidad.';
      return res.json({
        status: 'success',
        message,
        redirect: '/Crud?message=' + encodeURIComponent(message) + '&type=success',
        partialMatches: [],
      });
    }

    if (!req.file) {
      return res.redirect('/Crud?message=' + encodeURIComponent('No file uploaded.') + '&type=error');
    }

    const { numObjetivo, nucObjetivo, curso_dc, ano } = req.body;
    if (!numObjetivo || !nucObjetivo || !curso_dc || !ano) {
      return res.redirect('/Crud?message=' + encodeURIComponent('Objetivo, NUC, Año y Tipo son requeridos.') + '&type=error');
    }

    const csv = req.file.buffer.toString('utf8');
    let rowCount = 1;
    for (const character of csv) {
      if (character === '\n' && ++rowCount > CONTACTS_MAX_ROWS + 2) {
        return res.status(413).json({ status: 'error', message: 'El CSV supera el límite de 10000 filas.' });
      }
    }
    const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length > CONTACTS_MAX_ROWS + 1) {
      return res.status(413).json({ status: 'error', message: 'El CSV supera el límite de 10000 filas.' });
    }
    if (lines.length === 0) {
      return res.redirect('/Crud?message=' + encodeURIComponent('CSV no contiene datos válidos.') + '&type=error');
    }

    let headerIndex = -1;
    let headers = [];
    for (let i = 0; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]).map((header) => header.trim().toLowerCase());
      if (row.some((value) => value === 'contactos')) {
        headerIndex = i;
        headers = row;
        break;
      }
    }

    if (headerIndex === -1) {
      return res.redirect('/Crud?message=' + encodeURIComponent('CSV header debe incluir la columna: contactos.') + '&type=error');
    }

    const contactColumnIndex = headers.findIndex((value) => value === 'contactos');
    if (contactColumnIndex === -1) {
      return res.redirect('/Crud?message=' + encodeURIComponent('CSV header debe incluir la columna: contactos.') + '&type=error');
    }

    const contactosCSV = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const values = parseCsvRow(lines[i]);
      const contactoValue = values[contactColumnIndex] ? values[contactColumnIndex].trim() : '';
      if (contactoValue !== '' && /^\d+$/.test(contactoValue)) {
        contactosCSV.push(contactoValue);
      }
    }

    if (contactosCSV.length === 0) {
      return res.json({ status: 'error', message: 'CSV no contiene contactos válidos.' });
    }

    const forceFollowup = req.body.forceFollowup === 'true';
    const verificacion = await verificarObjetivoConContactos(numObjetivo, nucObjetivo, ano, contactosCSV);

    const normalizedTipo = String(curso_dc || '').trim().toLowerCase();
    const isSolucion = normalizedTipo === 'solución' || normalizedTipo === 'solucion';
    const mismosObjetivos = verificacion.objetivos || [];
    const tieneSolucionExistente = mismosObjetivos.some((obj) => {
      const tipoObj = String(obj.tipo || '').trim().toLowerCase();
      return tipoObj === 'solución' || tipoObj === 'solucion';
    });

    const validateOnly = req.query.validateOnly === 'true' || req.body.validateOnly === 'true';
    if (verificacion.conMismos && !forceFollowup) {
      return res.json({
        status: 'duplicado_detectado',
        message: 'Ya existe un objetivo idéntico con los mismos contactos. No se importará de nuevo.',
        duplicado: {
          numObjetivo,
          nuc: nucObjetivo,
          tipo: verificacion.conMismos.tipo,
          tipoExistente: verificacion.conMismos.tipo,
          contactosCount: verificacion.conMismos.contactos.length,
        }
      });
    }

    if (isSolucion && tieneSolucionExistente && !forceFollowup) {
      return res.json({
        status: 'confirm_followup',
        duplicado: {
          numObjetivo,
          nuc: nucObjetivo,
          tipoExistente: 'Solución',
          contactosCount: contactosCSV.length,
          message: 'Ya existe un objetivo Solución con ese número. ¿Desea guardarlo como Seguimiento?'
        }
      });
    }

    if (validateOnly) {
      return res.json({ status: 'ready' });
    }

    // Si está forzando seguimiento, usar el tipo "Seguimiento" en lugar del que envió
    let cursoToUse = curso_dc;
    if (forceFollowup && (verificacion.conMismos || isSolucion)) {
      cursoToUse = 'Seguimiento';
    }

    // Obtener o crear objetivo con el tipo correcto
    const { idObjetivo, tipo: objetivoTipo } = await obtenerOCrearObjetivo(numObjetivo, nucObjetivo, cursoToUse, ano, delito);

    let insertCount = 0;
    let exactDuplicateCount = 0;
    const exactDuplicates = [];
    const partialMatches = [];

    for (let i = headerIndex + 1; i < lines.length; i++) {
      const values = parseCsvRow(lines[i]);
      const contactoValue = values[contactColumnIndex] ? values[contactColumnIndex].trim() : '';
      if (contactoValue !== '') {
        if (/^\d+$/.test(contactoValue)) {
          const alreadyExists = await contactoExisteExacto(contactoValue, numObjetivo, nucObjetivo, objetivoTipo, ano);
          if (!alreadyExists) {
            await agregarContacto(contactoValue, idObjetivo);
            insertCount += 1;
            const partials = await contactoCoincidenciasParciales(contactoValue, numObjetivo, nucObjetivo, objetivoTipo, ano);
            partials.slice(0, MAX_REDIRECT_ITEMS - partialMatches.length).forEach((match) => {
              partialMatches.push({
                contacto: contactoValue,
                numObjetivo: match.numObjetivo,
                nuc: match.nuc,
                ano: match.ano,
                tipo: match.tipo,
              });
            });
          } else {
            exactDuplicateCount += 1;
            exactDuplicates.push({
              contacto: contactoValue,
              numObjetivo,
              nuc: nucObjetivo,
              ano,
              tipo: objetivoTipo,
            });
          }
        }
      }
    }

    let message = `CSV imported successfully. ${insertCount} contacts added.`;
    if (exactDuplicateCount > 0) {
      message += ` ${exactDuplicateCount} duplicate contacts skipped.`;
    }
    if (partialMatches.length > 0) {
      message += ` ${partialMatches.length} inserted contacts have partial matches with other objectives/NUC/año.`;
    }

    const redirectUrl = '/Crud?message=' + encodeURIComponent(message) + '&type=success';

    return res.json({
      status: 'success',
      message: message,
      redirect: redirectUrl,
      exactDuplicates,
      partialMatches
    });
  } catch (error) {
    console.error(error);
    return res.json({
      status: 'error',
      message: req.body.sinUtilidad === 'true' ? 'No se pudo registrar la línea sin utilidad.' : 'CSV import failed.',
    });
  }
});

// Registrar un nuevo estudiante
router.post("/estudiantes", requireRecordCreator, async (req, res, next) => {
  const { nombre_alumno, email_alumno, curso_alumno } = req.body;

  try {
    await agregarEstudiante({ nombre_alumno, email_alumno, curso_alumno });
    res.redirect("/Crud");
  } catch (error) {
    return next(error);
  }
});

export default router;
