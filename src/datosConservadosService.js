import { validarAgencia } from './agencias.js';
import { readFileSync } from 'node:fs';
import { validarPeriodo } from './metricasService.js';

export const camposDatosConservados = [
  ['nuc', 'NUC', 'text'], ['control_ing', 'Control ING', 'text'],
  ['estatus', 'Estatus', 'text'], ['fecha_envio', 'Fecha y hora de envío', 'datetime-local'],
  ['informe_udai', 'Informe UDAI', 'text'], ['recibido', 'Recibido', 'date'],
  ['agencia', 'Agencia', 'text'], ['ciudad', 'Ciudad', 'select'],
  ['delito', 'Delito', 'text'], ['resolucion', 'Resolución', 'text'],
  ['imei', 'IMEI', 'text', true], ['imei_descrito', 'IMEI descrito', 'text', true],
  ['utilidad', 'Utilidad', 'text'], ['fecha_utilidad', 'Fecha utilidad', 'date'],
  ['oficio_mp', 'Oficio MP', 'text'], ['fecha_oficio_mp', 'Fecha oficio MP', 'date'],
  ['analizado_por', 'Analizado por', 'text'], ['firma_ingeniero', 'Firma ingeniero', 'text'],
  ['elaboro_informe', 'Elaboró informe', 'text'], ['firma_licenciado', 'Firma licenciado', 'text'],
  ['dvd', 'DVD', 'text'], ['oficio_bodega', 'Oficio bodega', 'text'],
  ['observaciones', 'Observaciones', 'textarea'], ['enviado_a', 'Enviado a', 'text'],
].map(([key, label, type]) => [key, label, type, key !== 'nuc']);
const normalize = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const cabeceras = new Set(JSON.parse(readFileSync(new URL('./cabecerasSonora.json', import.meta.url), 'utf8')).cabeceras.map(normalize));

export function validarDatosConservados(body = {}) {
  const datos = {};
  for (const [key, label, type, optional] of camposDatosConservados) {
    const raw = body[key];
    if (raw != null && typeof raw !== 'string') throw new Error(`${label}: valor inválido.`);
    const value = (raw || '').trim();
    if (!value && optional) { datos[key] = null; continue; }
    if (!value || value.length > (type === 'textarea' ? 5000 : 255)) throw new Error(`Completa ${label} con un valor válido.`);
    if (type === 'date') validarPeriodo(value, value);
    if (type === 'datetime-local') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14)) > 59) throw new Error('Fecha y hora de envío inválida.');
      validarPeriodo(value.slice(0, 10), value.slice(0, 10));
    }
    datos[key] = type === 'datetime-local' ? value.replace('T', ' ') + ':00' : value;
  }
  if (datos.ciudad && !cabeceras.has(normalize(datos.ciudad))) throw new Error('Selecciona una cabecera municipal de Sonora.');
  const sinCantidad = body.lineas == null || (typeof body.lineas === 'string' && !body.lineas.trim());
  datos.lineas = sinCantidad ? null : Number(body.lineas);
  if (!sinCantidad && (!['string', 'number'].includes(typeof body.lineas) || !Number.isInteger(datos.lineas) || datos.lineas < 0 || datos.lineas > 1000)) throw new Error('Indica entre 0 y 1000 líneas.');
  const descritas = body.lineas_descritas ?? [];
  if (!Array.isArray(descritas) || descritas.length > 1000 || (datos.lineas !== null && descritas.length > datos.lineas)) throw new Error('Revisa la cantidad de líneas descritas.');
  const lineas = descritas.map((value) => {
    if (value === null) return null;
    if (typeof value !== 'string' || value.trim().length > 50) throw new Error('Cada línea admite un máximo de 50 caracteres.');
    return value.trim() || null;
  });
  datos.lineas_descritas = lineas.some(Boolean) ? lineas : null;
  validarAgencia(datos.agencia);
  return datos;
}

export async function crearTablaDatosConservados(db) {
  const columns = camposDatosConservados.map(([key, , type, optional]) => {
    const sqlType = type === 'date' ? 'DATE' : type === 'datetime-local' ? 'DATETIME' : type === 'textarea' ? 'TEXT' : 'VARCHAR(255)';
    return `${key} ${sqlType} ${optional ? 'NULL' : 'NOT NULL'}`;
  });
  await db.query(`CREATE TABLE IF NOT EXISTS DatosConservados (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ${columns.join(',\n')},
    lineas SMALLINT UNSIGNED NULL,
    lineas_descritas JSON NULL,
    creado_por BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX datos_conservados_fecha_envio (fecha_envio)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  // Actualiza también tablas creadas antes de permitir campos opcionales.
  await db.query(`ALTER TABLE DatosConservados ${columns.map(column => `MODIFY COLUMN ${column}`).join(', ')},
    MODIFY COLUMN lineas SMALLINT UNSIGNED NULL,
    MODIFY COLUMN lineas_descritas JSON NULL`);
}

export async function guardarDatosConservados(db, datos, userId) {
  const keys = camposDatosConservados.map(([key]) => key);
  const values = [...keys.map(key => datos[key]), datos.lineas, datos.lineas_descritas === null ? null : JSON.stringify(datos.lineas_descritas), userId];
  const [result] = await db.execute(`INSERT INTO DatosConservados
    (${keys.join(', ')}, lineas, lineas_descritas, creado_por)
    VALUES (${values.map(() => '?').join(', ')})`, values);
  return result.insertId;
}
