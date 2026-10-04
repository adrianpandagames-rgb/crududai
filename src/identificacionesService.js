import { validarAgencia } from './agencias.js';
import { readFileSync } from 'node:fs';

const normalize = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const cabeceras = new Set(JSON.parse(readFileSync(new URL('./cabecerasSonora.json', import.meta.url), 'utf8')).cabeceras.map(normalize));
const campos = {
  nuc: 'NUC', oficioUdai: 'Oficio UDAI', oficioMp: 'Oficio MP',
  agencia: 'Agencia', ciudad: 'Ciudad', delito: 'Delito',
  elaboradoPor: 'Elaborado por', firma: 'Firma', enviadoA: 'Enviado a',
};

export function validarIdentificacion(body = {}) {
  const datos = {};
  if (body.tipoRegistro !== 'Identificación de línea') throw new Error('Selecciona Identificación de línea.');
  for (const [key, label] of Object.entries(campos)) {
    const value = typeof body[key] === 'string' ? body[key].trim() : '';
    if (!value || value.length > 255) throw new Error(`${label}: ingresa entre 1 y 255 caracteres.`);
    datos[key] = value;
  }
  for (const [key, label] of [['fechaEnvio', 'Fecha de envío'], ['recibido', 'Recibido']]) {
    const value = body[key];
    const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(NaN);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '1000-01-01') {
      throw new Error(`${label}: selecciona una fecha válida.`);
    }
    datos[key] = value;
  }
  if (!['correo', 'fisico'].includes(body.medio)) throw new Error('Selecciona Correo o Físico.');
  datos.medio = body.medio;
  if (!cabeceras.has(normalize(datos.ciudad))) throw new Error('Selecciona una cabecera municipal de Sonora.');
  const count = typeof body.lineasCount === 'string' || typeof body.lineasCount === 'number' ? Number(body.lineasCount) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('La cantidad de líneas debe estar entre 1 y 1000.');
  if (!Array.isArray(body.lineasDescritas) || body.lineasDescritas.length !== count) throw new Error('La cantidad de líneas descritas no coincide.');
  datos.lineasDescritas = body.lineasDescritas.map((linea) => {
    if (typeof linea !== 'string' || !linea.trim() || linea.trim().length > 50) throw new Error('Completa cada línea con un máximo de 50 caracteres.');
    return linea.trim();
  });
  datos.lineasCount = count;
  validarAgencia(datos.agencia);
  return datos;
}

export async function crearTablaIdentificaciones(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS Identificaciones (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nuc VARCHAR(255) NOT NULL,
    oficio_udai VARCHAR(255) NOT NULL,
    fecha_envio DATE NOT NULL,
    oficio_mp VARCHAR(255) NOT NULL,
    recibido DATE NOT NULL,
    medio ENUM('correo', 'fisico') NOT NULL,
    agencia VARCHAR(255) NOT NULL,
    ciudad VARCHAR(255) NOT NULL,
    delito VARCHAR(255) NOT NULL,
    lineas SMALLINT UNSIGNED NOT NULL,
    lineas_descritas JSON NOT NULL,
    elaborado_por VARCHAR(255) NOT NULL,
    firma VARCHAR(255) NOT NULL,
    enviado_a VARCHAR(255) NOT NULL,
    creado_por BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
}

export async function guardarIdentificacion(db, datos, userId) {
  const [result] = await db.execute(`INSERT INTO Identificaciones
    (nuc, oficio_udai, fecha_envio, oficio_mp, recibido, medio, agencia, ciudad, delito,
     lineas, lineas_descritas, elaborado_por, firma, enviado_a, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [datos.nuc, datos.oficioUdai, datos.fechaEnvio, datos.oficioMp, datos.recibido,
    datos.medio, datos.agencia, datos.ciudad, datos.delito, datos.lineasCount,
    JSON.stringify(datos.lineasDescritas), datos.elaboradoPor, datos.firma, datos.enviadoA, userId]);
  return result.insertId;
}
