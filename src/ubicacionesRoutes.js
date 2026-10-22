import express from "express";
import { readFileSync } from 'node:fs';
import { forwardAsyncErrors } from './errorHandling.js';
import { requireRecordCreator } from './recordPermissions.js';
import { removeParentheticalText, capitalizeLocationWords } from './locationText.js';
import { listarUbicaciones, parseCoordinatesInput, agregarUbicacion, actualizarUbicacion } from "./estudianteController.js";
import { parsePagination } from './routeHelpers.js';
import pool from "./db.js";

const router = forwardAsyncErrors(express.Router());
const normalizarLocalidad = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const cabecerasSonora = new Set(JSON.parse(readFileSync(new URL('./cabecerasSonora.json', import.meta.url), 'utf8')).cabeceras.map(normalizarLocalidad));

router.get('/api/localidades', async (req, res, next) => {
  const state = String(req.query.estado || '').trim();
  try {
    if (!state) {
      const [rows] = await pool.query('SELECT DISTINCT estado FROM localidades_mexico ORDER BY estado');
      return res.json({ estados: rows.map((row) => row.estado) });
    }

    const [rows] = await pool.query(
      'SELECT localidad FROM localidades_mexico WHERE estado = ? ORDER BY localidad',
      [state],
    );
    const soloCabeceras = req.query.cabeceras === '1';
    const localidades = rows.map((row) => row.localidad).filter((localidad) =>
      !soloCabeceras || (normalizarLocalidad(state) === 'sonora' && cabecerasSonora.has(normalizarLocalidad(localidad)))
    );
    return res.json({ estado: state, localidades });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/ubicaciones/heatmap', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT latitude, longitude, COUNT(*) AS weight
      FROM ubicaciones
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      GROUP BY latitude, longitude
      ORDER BY weight DESC, latitude, longitude
    `);

    return res.json({
      points: rows.map((row) => ({
        lat: Number(row.latitude),
        lng: Number(row.longitude),
        weight: Number(row.weight) || 1,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/ubicaciones", async (req, res, next) => {
  try {
    const searchTerm = req.query.search || "";
    const { page, pageSize } = parsePagination(req.query);

    const { rows: ubicaciones, total } = await listarUbicaciones(searchTerm, page, pageSize);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const startIndex = (page - 1) * pageSize + 1;

    if (req.query.fragment === '1') {
      return res.render('partials/ubicaciones-results', {
        ubicaciones,
        searchTerm,
        currentPage: page,
        totalPages,
        startIndex,
        pageSize,
      });
    }

    res.render("pages/ubicaciones", {
      ubicaciones,
      searchTerm,
      message: req.query.message || null,
      messageType: req.query.type || null,
      currentPage: page,
      totalPages,
      startIndex,
      pageSize,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/ubicaciones/:id/modificar', async (req, res) => {
  if (req.session?.isAdmin !== true) {
    return res.status(403).json({ error: 'Solo los administradores pueden modificar ubicaciones.' });
  }
  const id = Number(req.params.id);
  const coordinates = parseCoordinatesInput(req.body.coordinates);
  const ubicacion = typeof req.body.ubicacion === 'string' ? req.body.ubicacion.trim() : '';
  const lugar = typeof req.body.lugar === 'string' ? req.body.lugar.trim() : '';
  if (!Number.isSafeInteger(id) || id < 1 || !coordinates ||
      !Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude) ||
      Math.abs(coordinates.latitude) > 90 || Math.abs(coordinates.longitude) > 180 || !ubicacion || !lugar) {
    return res.status(400).json({ error: 'Ingresa coordenadas válidas, ubicación y lugar.' });
  }
  try {
    await actualizarUbicacion(id, { ...coordinates, ubicacion, lugar });
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'No se pudo guardar la ubicación.' });
  }
});

router.post('/ubicaciones/register', requireRecordCreator, async (req, res) => {
  try {
    const { coordinates, ubicacion, estado, lugar } = req.body;
    const city = removeParentheticalText(lugar);
    const rawCoordinates = String(coordinates || '').trim();
    const parsedCoordinates = parseCoordinatesInput(rawCoordinates);

    if (!parsedCoordinates || !ubicacion || !estado || !city) {
      return res.redirect('/ubicaciones?message=' + encodeURIComponent('Coordenadas, ubicación, estado y ciudad son requeridos. Usa latitud y longitud numéricas o DMS.') + '&type=error');
    }

    const { latitude, longitude } = parsedCoordinates;
    const [localidades] = await pool.execute(
      'SELECT localidad, estado FROM localidades_mexico WHERE estado = ? AND localidad = ? LIMIT 1',
      [String(estado).trim(), String(lugar).trim()],
    );
    if (localidades.length === 0) {
      return res.redirect('/ubicaciones?message=' + encodeURIComponent('Selecciona una ciudad o localidad válida del estado elegido.') + '&type=error');
    }
    const selectedCity = capitalizeLocationWords(removeParentheticalText(localidades[0].localidad));
    const cityAndState = `${selectedCity}, ${localidades[0].estado}`;
    req.body.lugar = selectedCity;

    await agregarUbicacion({ latitude, longitude, ubicacion: ubicacion.trim(), lugar: cityAndState });
    return res.redirect('/ubicaciones?message=' + encodeURIComponent('Ubicación registrada con éxito.') + '&type=success');
  } catch (error) {
    console.error(error);
    const message = error && error.status === 409
      ? 'La coordenada ya se encuentra registrada.'
      : 'Error al registrar la ubicación.';
    return res.redirect('/ubicaciones?message=' + encodeURIComponent(message) + '&type=error');
  }
});

export default router;
