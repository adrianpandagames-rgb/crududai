import { fuentesMetricas } from './metricasService.js';
import { readFileSync } from 'node:fs';
const normalizar = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const cabeceras = new Set(JSON.parse(readFileSync(new URL('./cabecerasSonora.json', import.meta.url), 'utf8')).cabeceras.map(normalizar));
import { agencias } from './agencias.js';
import { validarIdentificacion } from './identificacionesService.js';
import { camposDatosConservados, validarDatosConservados } from './datosConservadosService.js';
import { camposRecepcion, validarRecepcion } from './recepcionesService.js';
import { camposExtraccion, validarExtraccion } from './extraccionesService.js';
import { camposInspeccion, validarInspeccion } from './inspeccionesService.js';
import { camposOficiosVarios, validarOficiosVarios } from './oficiosVariosService.js';
import { camposViaAlcance, validarViaAlcance } from './viaAlcanceService.js';
const identificacion = [
  ['nuc','NUC','text'], ['oficioUdai','Oficio UDAI','text','oficio_udai'],
  ['fechaEnvio','Fecha de envío','date','fecha_envio'], ['oficioMp','Oficio MP','text','oficio_mp'],
  ['recibido','Recibido','date'], ['medio','Medio','select'], ['agencia','Agencia','select'],
  ['ciudad','Ciudad','select'], ['delito','Delito','text'], ['lineasCount','Líneas','number','lineas'],
  ['lineasDescritas','Líneas descritas (una por renglón)','lines','lineas_descritas'],
  ['elaboradoPor','Elaborado por','text','elaborado_por'], ['firma','Firma','text'], ['enviadoA','Enviado a','text','enviado_a'],
];
const esquemas = [identificacion, [...camposDatosConservados, ['lineas','Líneas','number'], ['lineas_descritas','Líneas descritas (una por renglón)','lines']], camposRecepcion, camposExtraccion, camposInspeccion, camposOficiosVarios, camposViaAlcance];
const validadores = [validarIdentificacion, validarDatosConservados, validarRecepcion, validarExtraccion, validarInspeccion, validarOficiosVarios, validarViaAlcance];

function config(tipo, id) {
  const index = fuentesMetricas.findIndex(f => f.tipo === tipo);
  if (index < 0 || !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw Object.assign(new Error('Registro inválido.'), { status: 400 });
  const campos = esquemas[index].map(([nombre, etiqueta, tipoCampo, columna]) => ({ nombre, etiqueta, tipo: ['agencia','ciudad','medio','destruccion'].includes(nombre) ? 'select' : tipoCampo, columna: index === 0 ? columna || nombre : nombre, required: index === 0 || nombre === 'nuc' }));
  return { ...fuentesMetricas[index], campos, validar: validadores[index] };
}
export async function obtenerCarpeta(db, tipo, id) {
  const c = config(tipo, id);
  const columns = c.campos.map(f => {
    if (['date','datetime-local'].includes(f.tipo)) return `DATE_FORMAT(${f.columna}, '${f.tipo === 'date' ? '%Y-%m-%d' : '%Y-%m-%dT%H:%i'}') AS ${f.nombre}`;
    return `${f.columna} AS ${f.nombre}`;
  });
  const [[registro]] = await db.execute(`SELECT ${columns.join(', ')} FROM ${c.tabla} WHERE id = ?`, [id]);
  if (!registro) throw Object.assign(new Error('Registro no encontrado.'), { status: 404 });
  for (const field of c.campos.filter(f => f.tipo === 'lines')) {
    if (typeof registro[field.nombre] === 'string') registro[field.nombre] = JSON.parse(registro[field.nombre]);
  }
  const [ciudades] = await db.execute('SELECT localidad FROM localidades_mexico WHERE estado = ? ORDER BY localidad', ['Sonora']);
  return { registro, campos: c.campos, agencias, ciudades: ciudades.map(r => r.localidad).filter(ciudad => cabeceras.has(normalizar(ciudad))) };
}
export async function actualizarCarpeta(db, tipo, id, body) {
  const c = config(tipo, id);
  let datos;
  try { datos = c.validar({ ...body, tipoRegistro: tipo }); }
  catch (error) { error.status = 400; throw error; }
  if (datos.ciudad) {
    const [rows] = await db.execute('SELECT localidad FROM localidades_mexico WHERE estado = ? AND localidad = ?', ['Sonora', datos.ciudad]);
    if (!rows.length) throw Object.assign(new Error('Ciudad inválida.'), { status: 400 });
  }
  const values = c.campos.map(f => f.tipo === 'lines' && datos[f.nombre] != null ? JSON.stringify(datos[f.nombre]) : datos[f.nombre]);
  const [result] = await db.execute(`UPDATE ${c.tabla} SET ${c.campos.map(f => `${f.columna} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
  if (!result.affectedRows) {
    const [rows] = await db.execute(`SELECT id FROM ${c.tabla} WHERE id = ?`, [id]);
    if (!rows.length) throw Object.assign(new Error('Registro no encontrado.'), { status: 404 });
  }
}
