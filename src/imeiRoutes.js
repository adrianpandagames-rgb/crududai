import express from "express";
import { forwardAsyncErrors } from './errorHandling.js';
import { requireRecordCreator, requireRecordEditor } from './recordPermissions.js';
import {
  listarImeis,
  obtenerOCrearObjetivoImei,
  agregarImei,
  imeiExisteExacto,
  imeiCoincidenciasParciales,
  imeiCoincidenciasPorObjetivo,
  buscarObjetivoEnObjetivo,
  obtenerImeiPorId,
  actualizarImei,
} from "./estudianteController.js";
import { fetchImeiMetadata } from './imeiApiClient.js';
import { addJsonQueryParam, parsePagination } from './routeHelpers.js';

const router = forwardAsyncErrors(express.Router());

const calculateLuhnCheckDigit = (base) => {
  let sum = 0;

  for (let i = 0; i < base.length; i++) {
    let digit = Number(base[i]);
    if (i % 2 === 1) {
      digit *= 2;
    }
    sum += Math.floor(digit / 10) + (digit % 10);
  }

  return String((10 - (sum % 10)) % 10);
};

router.get('/imei/editar/:id', requireRecordEditor, async (req, res) => {
  const idImei = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(idImei) || idImei < 1) return res.status(400).send('IMEI inválido.');
  const imei = await obtenerImeiPorId(idImei);
  if (!imei) return res.status(404).send('IMEI no encontrado.');
  return res.render('pages/editar-imei', { imei, error: null });
});

router.post('/imei/editar/:id', requireRecordEditor, async (req, res) => {
  const idImei = Number.parseInt(req.params.id, 10);
  const imei = {
    idImei,
    imei: String(req.body.imei || '').replace(/\D/g, ''),
    numObjetivo: String(req.body.numObjetivo || '').trim(),
    nuc: String(req.body.nuc || '').trim(),
    tipo: String(req.body.tipo || '').trim(),
    ano: String(req.body.ano || '').trim(),
    brandName: String(req.body.brandName || '').trim(),
    modelo: String(req.body.modelo || '').trim(),
  };
  const validImei = /^\d{15}$/.test(imei.imei) && imei.imei[14] === String(calculateLuhnCheckDigit(imei.imei.slice(0, 14)));
  if (!Number.isSafeInteger(idImei) || idImei < 1 || !validImei || !imei.numObjetivo || !imei.nuc || !imei.tipo || !/^\d{4}$/.test(imei.ano)) {
    return res.status(400).render('pages/editar-imei', { imei, error: 'Completa todos los campos con valores válidos. El IMEI debe tener 15 dígitos válidos.' });
  }
  try {
    const updated = await actualizarImei(idImei, imei);
    if (!updated) return res.status(404).send('IMEI no encontrado.');
    return res.redirect('/imei?message=' + encodeURIComponent('IMEI actualizado correctamente.') + '&type=success');
  } catch (error) {
    return res.status(500).render('pages/editar-imei', { imei, error: 'No fue posible actualizar el IMEI.' });
  }
});

router.get("/imei", async (req, res, next) => {
  try {
    const searchTerm = req.query.search || "";
    const { page, pageSize } = parsePagination(req.query);

    const { rows: imeis, total } = await listarImeis(searchTerm, page, pageSize);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const startIndex = (page - 1) * pageSize + 1;

    if (req.query.fragment === '1') {
      return res.render('partials/imei-results', {
        imeis,
        searchTerm,
        currentPage: page,
        totalPages,
        startIndex,
        pageSize,
      });
    }

    res.render("pages/imei", {
      imeis,
      searchTerm,
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

router.post('/imei/register', requireRecordCreator, async (req, res) => {
  try {
    const { imeiBase, nucObjetivo, curso_dc, ano } = req.body;
    const normalizedImeiBase = String(imeiBase || '').replace(/\D/g, '').slice(0, 14);
    const imeiCompleto = normalizedImeiBase.length === 14
      ? normalizedImeiBase + calculateLuhnCheckDigit(normalizedImeiBase)
      : '';
    const rawObjetivos = req.body.numObjetivo || req.body['numObjetivo[]'];
    const objetivos = Array.isArray(rawObjetivos) ? rawObjetivos : rawObjetivos ? [rawObjetivos] : [];

    if (!/^\d{15}$/.test(imeiCompleto) || objetivos.length === 0 || !nucObjetivo || !curso_dc || !ano) {
      return res.redirect('/imei?message=' + encodeURIComponent('IMEI de 14 dígitos, al menos un Objetivo, NUC, Año y Tipo son requeridos.') + '&type=error');
    }

    const exactDuplicates = [];
    const partialMatches = [];
    let inserted = 0;
    let imeiMetadataUnavailable = false;

    for (const numObjetivo of objetivos) {
      if (!numObjetivo || numObjetivo.toString().trim() === '') {
        continue;
      }

      const { idObjetivo, tipo: objetivoTipo } = await obtenerOCrearObjetivoImei(numObjetivo, nucObjetivo, curso_dc, ano);
      const alreadyExists = await imeiExisteExacto(imeiCompleto, numObjetivo, nucObjetivo, objetivoTipo, ano);

      if (alreadyExists) {
        exactDuplicates.push({ imei: imeiCompleto, numObjetivo, nuc: nucObjetivo, ano, tipo: objetivoTipo });
        continue;
      }

      const objectiveDuplicates = await imeiCoincidenciasPorObjetivo(numObjetivo, nucObjetivo, ano, imeiCompleto);
      objectiveDuplicates.forEach((match) => {
        partialMatches.push({
          imei: match.imei,
          numObjetivo: match.numObjetivo,
          nuc: match.nuc,
          ano: match.ano,
          tipo: match.tipo,
          issue: match.issue,
        });
      });

      const objetivoEnObjetivo = await buscarObjetivoEnObjetivo(numObjetivo, nucObjetivo, ano);
      if (objetivoEnObjetivo.length > 0) {
        objetivoEnObjetivo.forEach((match) => {
          partialMatches.push({
            imei: imeiCompleto,
            numObjetivo: match.numObjetivo,
            nuc: match.nuc,
            ano: match.ano,
            tipo: match.tipo,
            issue: 'Objetivo también existe en tabla Objetivo',
          });
        });
      }

      const metadata = await fetchImeiMetadata(imeiCompleto);
      if (metadata?.available === false) {
        imeiMetadataUnavailable = true;
      }
      console.log('IMEI metadata for', imeiCompleto, metadata);
      await agregarImei(imeiCompleto, idObjetivo, metadata);
      inserted += 1;

      const partials = await imeiCoincidenciasParciales(imeiCompleto, numObjetivo, nucObjetivo, objetivoTipo, ano);
      partials.forEach((match) => {
        partialMatches.push({
          imei: imeiCompleto,
          numObjetivo: match.numObjetivo,
          nuc: match.nuc,
          ano: match.ano,
          tipo: match.tipo,
          issue: match.issue,
        });
      });
    }

    let message;
    let messageType = 'success';

    if (inserted === 0) {
      message = 'No se registró ningún IMEI porque todos los objetivos ya existen exactamente con ese IMEI.';
      messageType = 'error';
    } else if (partialMatches.length > 0) {
      message = `IMEI registrado correctamente en ${inserted} objetivo(s). Existe una coincidencia parcial con otros objetivos/NUC/año.`;
    } else {
      message = `IMEI registrado con éxito, se han registrado ${inserted} objetivo(s).`;
    }

    let redirectUrl = '/imei?message=' + encodeURIComponent(message) + '&type=' + encodeURIComponent(messageType);
    if (imeiMetadataUnavailable) {
      redirectUrl += '&toastMessage=' + encodeURIComponent('El sistema de IMEI no está disponible. El IMEI se registrará sin estos datos.');
    }
    redirectUrl = addJsonQueryParam(redirectUrl, 'exactDuplicates', exactDuplicates);
    redirectUrl = addJsonQueryParam(redirectUrl, 'partials', partialMatches);

    return res.redirect(redirectUrl);
  } catch (error) {
    console.error(error);
    return res.redirect('/imei?message=' + encodeURIComponent('Registro de IMEI falló.') + '&type=error');
  }
});

export default router;
