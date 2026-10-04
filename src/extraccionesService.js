import { validarAgencia } from './agencias.js';
import { readFileSync } from 'node:fs';
import { validarPeriodo } from './metricasService.js';

export const camposExtraccion = [
  ['nuc', 'NUC', 'text'], ['estatus', 'Estatus', 'text'],
  ['fecha_envio', 'Fecha y hora de enviado', 'datetime-local'],
  ['informe', 'Informe', 'text'], ['acta', 'Acta', 'text'],
  ['oficio_mp', 'Oficio MP', 'text'], ['fecha_oficio_mp', 'Fecha oficio MP', 'date'],
  ['recibido', 'Recibido (fecha y hora)', 'datetime-local'],
  ['oficio_bodega_mp', 'Oficio bodega MP', 'text'], ['agencia', 'Agencia', 'text'],
  ['ciudad', 'Ciudad', 'select'], ['delito', 'Delito', 'text'], ['resolucion', 'Resolución', 'text'],
  ['indicios', 'Indicios', 'textarea'], ['cantidad_indicios', 'Cantidad de indicios', 'number'],
  ['descripcion_indicios', 'Descripción de indicios', 'textarea'], ['analisis', 'Análisis', 'text'],
  ['firma_ing', 'Firma ING', 'text'], ['elaboro_informe', 'Elaboró informe', 'text'],
  ['firma_lic', 'Firma LIC', 'text'], ['indicio_generado', 'Indicio generado', 'text'],
  ['oficio_bodega_udai', 'Oficio bodega UDAI', 'text'],
  ['observaciones', 'Observaciones', 'textarea'], ['enviado_a', 'Enviado a', 'text'],
];
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const cabeceras = new Set(JSON.parse(readFileSync(new URL('./cabecerasSonora.json', import.meta.url), 'utf8')).cabeceras.map(normalize));

export function validarExtraccion(body = {}) {
  const datos = {};
  for (const [key, label, type] of camposExtraccion) {
    const raw = body[key];
    if (raw != null && typeof raw !== 'string' && !(type === 'number' && typeof raw === 'number')) throw new Error(`${label}: valor inválido.`);
    const value = raw == null ? '' : String(raw).trim();
    if (!value && key !== 'nuc') { datos[key] = null; continue; }
    const max = type === 'textarea' ? 5000 : 255;
    if (!value || value.length > max) throw new Error(`${label}: ingresa entre 1 y ${max} caracteres.`);
    if (type === 'date') validarPeriodo(value, value);
    if (type === 'datetime-local') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14)) > 59) throw new Error(`${label}: fecha y hora inválidas.`);
      validarPeriodo(value.slice(0, 10), value.slice(0, 10));
    }
    if (type === 'number') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 4294967295) throw new Error('Cantidad de indicios: ingresa un entero entre 0 y 4294967295.');
      datos[key] = Number(value);
    } else {
      datos[key] = type === 'datetime-local' ? value.replace('T', ' ') + ':00' : value;
    }
  }
  if (datos.ciudad && !cabeceras.has(normalize(datos.ciudad))) throw new Error('Selecciona una cabecera municipal de Sonora.');
  validarAgencia(datos.agencia);
  return datos;
}

export async function crearTablaExtracciones(db) {
  const columns = camposExtraccion.map(([key,,type]) => {
    const sqlType = { date: 'DATE', 'datetime-local': 'DATETIME', textarea: 'TEXT', number: 'INT UNSIGNED' }[type] || 'VARCHAR(255)';
    return `${key} ${sqlType} ${key === 'nuc' ? 'NOT NULL' : 'NULL'}`;
  });
  await db.query(`CREATE TABLE IF NOT EXISTS Extracciones (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ${columns.join(',\n')},
    creado_por BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX extracciones_fecha_envio (fecha_envio)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
}

export async function guardarExtraccion(db, datos, userId) {
  const keys = camposExtraccion.map(([key]) => key);
  const values = [...keys.map(key => datos[key]), userId];
  const [result] = await db.execute(`INSERT INTO Extracciones (${keys.join(', ')}, creado_por)
    VALUES (${values.map(() => '?').join(', ')})`, values);
  return result.insertId;
}
