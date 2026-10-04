import { validarAgencia } from './agencias.js';
import { readFileSync } from 'node:fs';
import { validarPeriodo } from './metricasService.js';

export const camposRecepcion = [
  ['nuc', 'NUC', 'text'], ['oficio_udai', 'Oficio UDAI', 'text'],
  ['fecha_envio', 'Fecha y hora de envío', 'datetime-local'], ['fecha_recibido', 'Fecha recibido', 'date'],
  ['agencia', 'Agencia', 'text'], ['ciudad', 'Ciudad', 'select'],
  ['resolucion', 'Resolución', 'text'], ['lineas', 'Líneas', 'text'],
  ['imei', 'IMEI', 'text'], ['util', 'Útil', 'text'],
  ['destruccion', 'Destrucción', 'select'], ['acta_destruccion', 'Acta de destrucción', 'text'],
  ['elaboro', 'Elaboró', 'text'], ['reviso', 'Revisó', 'text'],
  ['firma_ingeniero', 'Firma ingeniero', 'text'], ['firma_licenciado', 'Firma licenciado', 'text'],
  ['enviado_a', 'Enviado a', 'text'],
];
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const cabeceras = new Set(JSON.parse(readFileSync(new URL('./cabecerasSonora.json', import.meta.url), 'utf8')).cabeceras.map(normalize));

export function validarRecepcion(body = {}) {
  const datos = {};
  for (const [key, label, type] of camposRecepcion) {
    if (key === 'acta_destruccion' && body.destruccion !== 'si') { datos[key] = null; continue; }
    const raw = body[key];
    if (raw != null && typeof raw !== 'string') throw new Error(`${label}: valor inválido.`);
    const value = (raw || '').trim();
    if (!value && key !== 'nuc') { datos[key] = null; continue; }
    if (!value || value.length > 255) throw new Error(`${label}: ingresa entre 1 y 255 caracteres.`);
    if (type === 'date') validarPeriodo(value, value);
    if (type === 'datetime-local') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14)) > 59) throw new Error('Fecha y hora de envío inválida.');
      validarPeriodo(value.slice(0, 10), value.slice(0, 10));
    }
    datos[key] = type === 'datetime-local' ? value.replace('T', ' ') + ':00' : value;
  }
  if (datos.destruccion !== null && !['si', 'no'].includes(datos.destruccion)) throw new Error('Destrucción debe ser Sí o No.');
  if (datos.ciudad && !cabeceras.has(normalize(datos.ciudad))) throw new Error('Selecciona una cabecera municipal de Sonora.');
  validarAgencia(datos.agencia);
  return datos;
}

export async function crearTablaRecepciones(db) {
  const columns = camposRecepcion.map(([key,,type]) => {
    const sqlType = type === 'date' ? 'DATE' : type === 'datetime-local' ? 'DATETIME' : key === 'destruccion' ? "ENUM('si', 'no')" : 'VARCHAR(255)';
    return `${key} ${sqlType} ${key === 'nuc' ? 'NOT NULL' : 'NULL'}`;
  });
  await db.query(`CREATE TABLE IF NOT EXISTS Recepciones (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ${columns.join(',\n')},
    creado_por BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX recepciones_fecha_envio (fecha_envio)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
}

export async function guardarRecepcion(db, datos, userId) {
  const keys = camposRecepcion.map(([key]) => key);
  const values = [...keys.map(key => datos[key]), userId];
  const [result] = await db.execute(`INSERT INTO Recepciones (${keys.join(', ')}, creado_por)
    VALUES (${values.map(() => '?').join(', ')})`, values);
  return result.insertId;
}
