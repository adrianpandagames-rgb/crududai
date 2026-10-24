import { getGoogleGeocodingQuota } from './googleGeocodingQuota.js';

export const TOP_CIUDADES = 15;
export const DIAS_TENDENCIA = 30;

// Long city lists are unreadable as bars, so everything past the top ones is summed as "Otras".
export const agruparCiudades = (rows, limite = TOP_CIUDADES) => {
  const ciudades = rows.map(({ ciudad, total }) => ({ ciudad, total: Number(total) || 0 }));
  if (ciudades.length <= limite) return ciudades;
  const resto = ciudades.slice(limite);
  return [
    ...ciudades.slice(0, limite),
    { ciudad: `Otras (${resto.length})`, total: resto.reduce((sum, { total }) => sum + total, 0), otras: true },
  ];
};

// The query only returns days with records; the chart needs every day, oldest first.
// `hoy` comes from the database so the days match the dates MySQL grouped by.
export const completarDias = (rows, hoy, dias = DIAS_TENDENCIA) => {
  const totales = new Map(rows.map(({ dia, total }) => [dia, Number(total) || 0]));
  const fin = new Date(`${hoy}T00:00:00Z`);
  return Array.from({ length: dias }, (_, index) => {
    const fecha = new Date(fin);
    fecha.setUTCDate(fin.getUTCDate() - (dias - 1 - index));
    const dia = fecha.toISOString().slice(0, 10);
    return { dia, total: totales.get(dia) || 0 };
  });
};

export const obtenerMedidores = async (pool) => {
  const [[metricRows], [cityRows], [trendRows], googleGeocodingQuota] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM objetivo) AS objetivos,
        (SELECT COUNT(*) FROM objetivoImei) AS objetivosImei,
        (SELECT COUNT(*) FROM imei) AS imeis,
        (SELECT COUNT(*) FROM contactos) AS contactos,
        (SELECT COUNT(*) FROM ubicaciones) AS ubicaciones,
        (SELECT COUNT(*) FROM users) AS usuarios,
        (SELECT COUNT(*) FROM imei WHERE brand_name IS NOT NULL AND modelo IS NOT NULL) AS imeisConMetadata,
        (SELECT COUNT(*) FROM imei WHERE brand_name IS NULL OR modelo IS NULL) AS imeisPendientes,
        (SELECT COUNT(*) FROM ubicaciones WHERE latitude IS NULL OR longitude IS NULL) AS ubicacionesSinCoordenadas,
        (SELECT COUNT(*) FROM ubicaciones WHERE lugar IS NULL OR TRIM(lugar) = '') AS ubicacionesSinCiudad,
        (SELECT COUNT(*) FROM objetivoImei o WHERE NOT EXISTS (SELECT 1 FROM imei i WHERE i.idObjetivo = o.idObjetivo)) AS objetivosImeiSinImei,
        (SELECT COUNT(*) FROM objetivo o WHERE NOT EXISTS (SELECT 1 FROM contactos c WHERE c.idObjetivo = o.idObjetivo)) AS objetivosSinContactos,
        DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy
    `),
    pool.query(`
      SELECT COALESCE(NULLIF(TRIM(lugar), ''), 'Sin ciudad') AS ciudad, COUNT(*) AS total
      FROM ubicaciones
      GROUP BY COALESCE(NULLIF(TRIM(lugar), ''), 'Sin ciudad')
      ORDER BY total DESC, ciudad ASC
    `),
    pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS dia, COUNT(*) AS total
      FROM ubicaciones
      WHERE created_at >= CURDATE() - INTERVAL ${DIAS_TENDENCIA - 1} DAY
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    `),
    getGoogleGeocodingQuota(pool),
  ]);

  const { hoy, ...counts } = metricRows[0] || {};
  const metrics = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value) || 0]));
  const tendencia = completarDias(trendRows, hoy || new Date().toISOString().slice(0, 10));
  const imeisTotal = metrics.imeisConMetadata + metrics.imeisPendientes;

  return {
    metrics,
    imeiCompletion: imeisTotal ? Math.round((metrics.imeisConMetadata / imeisTotal) * 100) : 0,
    antennasByCity: agruparCiudades(cityRows),
    totalCiudades: cityRows.length,
    tendencia,
    ultimos7: tendencia.slice(-7).reduce((sum, { total }) => sum + total, 0),
    ultimos30: tendencia.reduce((sum, { total }) => sum + total, 0),
    googleGeocodingQuota,
  };
};
