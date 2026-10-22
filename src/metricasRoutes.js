import express from "express";
import { forwardAsyncErrors } from './errorHandling.js';
import { requireRecordEditor } from './recordPermissions.js';
import { obtenerCarpeta, actualizarCarpeta } from './editarCarpetasService.js';
import { validarConsultaRegistros, listarRegistrosCarpetas } from './registrosCarpetasService.js';
import { agencias } from './agencias.js';
import { camposViaAlcance, validarViaAlcance, guardarViaAlcance } from './viaAlcanceService.js';
import { camposOficiosVarios, validarOficiosVarios, guardarOficiosVarios } from './oficiosVariosService.js';
import { camposInspeccion, validarInspeccion, guardarInspeccion } from './inspeccionesService.js';
import { camposExtraccion, validarExtraccion, guardarExtraccion } from './extraccionesService.js';
import { camposRecepcion, validarRecepcion, guardarRecepcion } from './recepcionesService.js';
import { camposDatosConservados, validarDatosConservados, guardarDatosConservados } from './datosConservadosService.js';
import { validarPeriodo, validarFiltrosMetricas, obtenerMetricas, fuentesMetricas } from './metricasService.js';
import { validarIdentificacion, guardarIdentificacion } from './identificacionesService.js';
import pool from "./db.js";

const router = forwardAsyncErrors(express.Router());

router.get('/metricas', (_req, res) => {
  res.render('pages/metricas', { agencias, fuentesMetricas, camposDatosConservados, camposRecepcion, camposExtraccion, camposInspeccion, camposOficiosVarios, camposViaAlcance });
});

// The folder forms share one flow: validate, check the Sonora city when given, save.
const registrarFormulario = (ruta, validar, guardar, { registro, exito, fallo }) => {
  router.post(ruta, async (req, res) => {
    let datos;
    try {
      datos = validar(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      if (datos.ciudad) {
        const [rows] = await pool.execute('SELECT localidad FROM localidades_mexico WHERE estado = ? AND localidad = ? LIMIT 1', ['Sonora', datos.ciudad]);
        if (!rows.length) return res.status(400).json({ error: 'Selecciona una ciudad del catálogo de Sonora.' });
      }
      const id = await guardar(pool, datos, req.session.userId);
      return res.status(201).json({ id, message: exito });
    } catch (error) {
      console.error(`Error al guardar ${registro}:`, error.code || 'Error de base de datos');
      return res.status(500).json({ error: fallo });
    }
  });
};

registrarFormulario('/metricas/via-alcance', validarViaAlcance, guardarViaAlcance, {
  registro: 'vía alcance', exito: 'Vía alcance registrada correctamente.', fallo: 'No fue posible guardar vía alcance. Intenta nuevamente.',
});
registrarFormulario('/metricas/oficios-varios', validarOficiosVarios, guardarOficiosVarios, {
  registro: 'oficio', exito: 'Oficio registrado correctamente.', fallo: 'No fue posible guardar el oficio. Intenta nuevamente.',
});
registrarFormulario('/metricas/inspecciones', validarInspeccion, guardarInspeccion, {
  registro: 'inspección', exito: 'Inspección registrada correctamente.', fallo: 'No fue posible guardar la inspección. Intenta nuevamente.',
});
registrarFormulario('/metricas/extracciones', validarExtraccion, guardarExtraccion, {
  registro: 'extracción', exito: 'Extracción registrada correctamente.', fallo: 'No fue posible guardar la extracción. Intenta nuevamente.',
});
registrarFormulario('/metricas/recepciones', validarRecepcion, guardarRecepcion, {
  registro: 'recepción', exito: 'Recepción registrada correctamente.', fallo: 'No fue posible guardar la recepción. Intenta nuevamente.',
});
registrarFormulario('/metricas/datos-conservados', validarDatosConservados, guardarDatosConservados, {
  registro: 'datos conservados', exito: 'Datos conservados registrados correctamente.', fallo: 'No fue posible guardar. Conservamos los campos para que puedas reintentar.',
});

router.get('/metricas/resumen', async (req, res) => {
  try {
    validarPeriodo(req.query.inicio, req.query.fin);
    validarFiltrosMetricas(req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const resumen = await obtenerMetricas(pool, req.query.inicio, req.query.fin, req.query);
    res.set('Cache-Control', 'no-store');
    return res.json(resumen);
  } catch {
    return res.status(500).json({ error: 'No fue posible consultar las métricas. Intenta nuevamente.' });
  }
});

router.get('/metricas/registros', async (req, res) => {
  try {
    validarConsultaRegistros(req.query.tipo, req.query.pagina);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const result = await listarRegistrosCarpetas(pool, req.query.tipo, req.query.pagina);
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch {
    return res.status(500).json({ error: 'No fue posible cargar los registros. Intenta nuevamente.' });
  }
});

router.get('/metricas/registros/:id', requireRecordEditor, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json(await obtenerCarpeta(pool, req.query.tipo, req.params.id));
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'No fue posible cargar el registro.' });
  }
});
router.post('/metricas/registros/:id', requireRecordEditor, async (req, res) => {
  try {
    await actualizarCarpeta(pool, req.query.tipo, req.params.id, req.body);
    return res.json({ message: 'Registro actualizado correctamente.' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'No fue posible guardar los cambios.' });
  }
});

router.post('/metricas/identificaciones', async (req, res) => {
  let datos;
  try {
    datos = validarIdentificacion(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const [ciudades] = await pool.execute(
      'SELECT localidad FROM localidades_mexico WHERE estado = ? AND localidad = ? LIMIT 1',
      ['Sonora', datos.ciudad],
    );
    if (!ciudades.length) return res.status(400).json({ error: 'La ciudad no está en el catálogo de Sonora.' });
    const id = await guardarIdentificacion(pool, datos, req.session.userId);
    return res.status(201).json({ id, message: 'Identificación registrada correctamente.' });
  } catch (error) {
    console.error('No fue posible guardar la identificación:', error.code || 'Error de base de datos');
    return res.status(500).json({ error: 'No fue posible guardar la identificación. Intenta nuevamente.' });
  }
});

export default router;
