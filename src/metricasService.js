export function validarPeriodo(inicio, fin) {
  for (const value of [inicio, fin]) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1000-01-01') throw new Error('Selecciona fechas válidas.');
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Selecciona fechas válidas.');
  }
  if (inicio > fin) throw new Error('La fecha de inicio no puede ser posterior a la fecha final.');
  return { inicio, fin };
}

export const fuentesMetricas = [
  { tabla: 'Identificaciones', tipo: 'Identificación de línea', medio: true, delito: true },
  { tabla: 'DatosConservados', tipo: 'Datos Conservados', delito: true, estatus: true },
  { tabla: 'Recepciones', tipo: 'Recepción' },
  { tabla: 'Extracciones', tipo: 'Extracción', delito: true, estatus: true },
  { tabla: 'Inspecciones', tipo: 'Inspección', medio: true, delito: true },
  { tabla: 'OficiosVarios', tipo: 'Oficios varios', medio: true, delito: true },
  { tabla: 'ViaAlcance', tipo: 'Vía alcance', medio: true, delito: true },
];

export function validarFiltrosMetricas(query = {}) {
  const filtros = {};
  for (const key of ['tipo', 'ciudad', 'agencia', 'delito', 'medio', 'estatus', 'nuc', 'enviado_a']) {
    const raw = query[key];
    if (raw != null && (typeof raw !== 'string' || raw.length > 255)) throw new Error('Los filtros deben contener textos de hasta 255 caracteres.');
    filtros[key] = (raw || '').trim();
  }
  if (filtros.tipo && !fuentesMetricas.some(f => f.tipo === filtros.tipo)) throw new Error('Selecciona un tipo de registro válido.');
  if (filtros.medio && !['correo', 'fisico'].includes(filtros.medio)) throw new Error('Selecciona Correo o Físico.');
  return filtros;
}

export async function obtenerMetricas(db, inicio, fin, query = {}) {
  validarPeriodo(inicio, fin);
  const filtros = validarFiltrosMetricas(query);
  const tipos = [];
  for (const fuente of fuentesMetricas) {
    if (filtros.tipo && filtros.tipo !== fuente.tipo) continue;
    const incompatible = ['medio', 'delito', 'estatus'].some(key => filtros[key] && !fuente[key]);
    if (incompatible) {
      tipos.push({ tipo: fuente.tipo, registros: 0 });
      continue;
    }
    const where = ['fecha_envio >= ?', 'fecha_envio <= ?'];
    const params = [inicio, `${fin} 23:59:59`];
    for (const key of ['ciudad', 'agencia', 'medio']) {
      if (filtros[key]) { where.push(`${key} = ?`); params.push(filtros[key]); }
    }
    for (const key of ['delito', 'estatus', 'nuc', 'enviado_a']) {
      if (filtros[key]) {
        where.push(`LOCATE(?, ${key}) > 0`);
        params.push(filtros[key]);
      }
    }
    const [[row]] = await db.execute(`SELECT COUNT(*) AS registros FROM ${fuente.tabla} WHERE ${where.join(' AND ')}`, params);
    tipos.push({ tipo: fuente.tipo, registros: Number(row.registros) });
  }
  return { inicio, fin, filtros, tipos, total: tipos.reduce((sum, item) => sum + item.registros, 0) };
}
