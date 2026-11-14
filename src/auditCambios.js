import { camposCarpeta } from './editarCarpetasService.js';

// What the audit log records about the record an action touched: its name ("Línea #12 · 6621234567") and,
// for edits and deletions, the values before and after as plain text, one field per line:
//   Número: 6621234567 → 6629876543
// The record is read before the route runs and again when the response finishes, so any route listed below
// is covered without touching its code. Column aliases are the field names people read.

const VACIO = '(vacío)';
const MAX_VALOR = 300;
// Compared to tell whether they changed, never written to the log.
const SECRETOS = new Set(['Contraseña']);
export const MAX_REGISTRO = 255;
export const MAX_CAMBIOS = 20000;

const quote = (name) => `\`${String(name).replace(/`/g, '``')}\``;
const deRuta = (match) => [match[1]];
const deSesion = (match, ctx) => [ctx.userId];

const usuarioSql = `SELECT email AS Correo, role AS Rol, IF(is_admin = 1, 'Sí', 'No') AS Administrador, puesto AS Puesto,
  IF(is_active = 1, 'Sí', 'No') AS Activo, IF(telegram_id_hash IS NULL, 'No', 'Sí') AS \`Telegram vinculado\`,
  IF(must_change_password = 1, 'Sí', 'No') AS \`Debe cambiar contraseña\`, SHA2(password, 256) AS \`Contraseña\`
  FROM users WHERE id = ?`;
const cuentaSql = `SELECT nombre AS Nombre, IF(foto IS NULL, 'Sin foto', 'Con foto') AS Foto, preferencias AS Preferencias
  FROM user_cuentas WHERE user_id = ?`;
const lineaSql = `SELECT numObjetivo AS \`Número\`, nuc AS NUC, ano AS \`Año\`, tipo AS Tipo, delito AS Delito
  FROM objetivo WHERE idObjetivo = ?`;
const imeiSql = `SELECT i.imei AS IMEI, i.brand_name AS Marca, i.modelo AS Modelo, o.numObjetivo AS \`Número\`, o.nuc AS NUC,
  o.ano AS \`Año\`, o.tipo AS Tipo
  FROM imei i LEFT JOIN objetivoImei o ON o.idObjetivo = i.idObjetivo WHERE i.idImei = ? LIMIT 1`;
const ubicacionSql = `SELECT ubicacion AS \`Ubicación\`, lugar AS Lugar, latitude AS Latitud, longitude AS Longitud
  FROM ubicaciones WHERE idUbicacion = ?`;
const perfilSql = `SELECT p.nombre AS Nombre, p.linea AS \`Línea\`, p.direccion AS \`Dirección\`, p.alias_osint AS \`Alias OSINT\`,
  (SELECT COUNT(*) FROM perfil_imagenes i WHERE i.perfil_id = p.id) AS \`Imágenes\`
  FROM perfiles p WHERE p.id = ?`;
const tareaSql = `SELECT t.titulo AS \`Título\`, t.descripcion AS \`Descripción\`, t.estado AS Estado,
  (SELECT email FROM users u WHERE u.id = t.licenciado_id) AS Licenciado,
  (SELECT email FROM users u WHERE u.id = t.ingeniero_id) AS Ingeniero,
  DATE_FORMAT(t.fecha_llegada, '%Y-%m-%d') AS \`Fecha de llegada\`,
  IF(t.licenciado_listo_at IS NULL, 'No', 'Sí') AS \`Listo licenciado\`, IF(t.ingeniero_listo_at IS NULL, 'No', 'Sí') AS \`Listo ingeniero\`,
  (SELECT GROUP_CONCAT(CONCAT(IF(c.hecho = 1, '[x] ', '[ ] '), c.texto) ORDER BY c.id SEPARATOR ' | ')
     FROM tareas_checklist c WHERE c.tarea_id = t.id) AS Checklist,
  (SELECT GROUP_CONCAT(e.nombre ORDER BY e.nombre SEPARATOR ', ')
     FROM tareas_etiquetas_tarea et JOIN tareas_etiquetas e ON e.id = et.etiqueta_id WHERE et.tarea_id = t.id) AS Etiquetas
  FROM tareas t WHERE t.id = ?`;
const rutaSql = `SELECT original_name AS Archivo, line_number AS \`Línea\`, status AS Estado, row_count AS Filas
  FROM ruta_archivos WHERE file_uuid = ?`;
const limpiezaSql = 'SELECT original_name AS Archivo, line_number AS `Línea` FROM limpieza_archivos WHERE file_uuid = ?';
const georeferenciacionSql = `SELECT original_name AS Archivo, line_number AS \`Línea\`, status AS Estado, row_count AS Filas
  FROM georeferenciacion_archivos WHERE file_uuid = ?`;
const imagenSql = `SELECT original_name AS Archivo, image_type AS Tipo, size_bytes AS Bytes,
  IF(public_token IS NULL, 'No', 'Sí') AS \`Enlace público\`, DATE_FORMAT(public_expires_at, '%Y-%m-%d %H:%i') AS \`Enlace vence\`
  FROM imagen_busquedas WHERE image_uuid = ?`;
const maigretSql = `SELECT username AS \`Usuario buscado\`, mode AS Modo, status AS Estado, accounts_found AS \`Cuentas encontradas\`
  FROM maigret_busquedas WHERE search_uuid = ?`;
const spiderfootSql = `SELECT target_shown AS Objetivo, target_type AS \`Tipo de objetivo\`, mode AS Modo, status AS Estado,
  events_found AS Eventos FROM spiderfoot_busquedas WHERE search_uuid = ?`;

// The record type's fields, as its edit form names them.
const carpetaSql = (match, req) => {
  const config = camposCarpeta(req.query?.tipo, match[1]);
  if (!config) return null;
  const columnas = config.campos.map((campo) => {
    const columna = quote(campo.columna);
    const valor = campo.tipo === 'date' ? `DATE_FORMAT(${columna}, '%Y-%m-%d')`
      : campo.tipo === 'datetime-local' ? `DATE_FORMAT(${columna}, '%Y-%m-%d %H:%i')` : columna;
    return `${valor} AS ${quote(campo.etiqueta)}`;
  });
  return `SELECT ${columnas.join(', ')} FROM ${quote(config.tabla)} WHERE id = ?`;
};

const ID = '(\\d+)';
const UUID = '([\\w-]{1,64})';
const ruta = (pattern) => new RegExp(`^${pattern}/?$`, 'i');

// tipo: editar (before → after), eliminar (the values removed) or exportar (only names the record).
export const registrosAuditados = [
  { patron: ruta(`/lineas/editar/${ID}`), nombre: 'Línea', tipo: 'editar', sql: lineaSql },
  { patron: ruta(`/imei/editar/${ID}`), nombre: 'IMEI', tipo: 'editar', sql: imeiSql },
  { patron: ruta(`/ubicaciones/${ID}/modificar`), nombre: 'Ubicación', tipo: 'editar', sql: ubicacionSql },
  { patron: ruta(`/metricas/registros/${ID}`), nombre: (match, req) => String(req.query?.tipo || 'Carpeta'), tipo: 'editar', sql: carpetaSql },
  { patron: ruta(`/perfiles/${ID}/(editar|imagenes|imagenes/eliminar)`), nombre: 'Perfil', tipo: 'editar', sql: perfilSql },
  { patron: ruta(`/perfiles/eliminar/${ID}`), nombre: 'Perfil', tipo: 'eliminar', sql: perfilSql },
  { patron: ruta(`/perfiles/imagenes/${ID}/eliminar`), nombre: 'Imagen de perfil', tipo: 'eliminar',
    sql: 'SELECT original_name AS Archivo, perfil_id AS Perfil FROM perfil_imagenes WHERE id = ?' },
  { patron: ruta(`/tareas/${ID}/(editar|mover|listo|checklist|checklist/\\d+|etiquetas|etiquetas/nueva|etiquetas/\\d+/eliminar)`),
    nombre: 'Tarea', tipo: 'editar', sql: tareaSql },
  { patron: ruta(`/tareas/eliminar/${ID}`), nombre: 'Tarea', tipo: 'eliminar', sql: tareaSql },
  { patron: ruta(`/usuarios/${ID}/(rol|puesto|estado|telegram|restablecer-contrasena)`), nombre: 'Usuario', tipo: 'editar', sql: usuarioSql },
  { patron: ruta('/(cambiar-contrasena|cuenta/contrasena)'), nombre: 'Usuario', tipo: 'editar', sql: usuarioSql, valores: deSesion },
  { patron: ruta('/cuenta/(nombre|foto|foto/eliminar|preferencias|tema)'), nombre: 'Mi cuenta', tipo: 'editar', sql: cuentaSql, valores: deSesion },
  { patron: ruta(`/ruta/eliminar/${UUID}`), nombre: 'Ruta', tipo: 'eliminar', sql: rutaSql },
  { patron: ruta(`/ruta/(?:exportar|exportar-xlsx|exportar-kmz)/${UUID}`), nombre: 'Ruta', tipo: 'exportar', sql: rutaSql },
  { patron: ruta(`/limpieza/eliminar/${UUID}`), nombre: 'Sábana limpia', tipo: 'eliminar', sql: limpiezaSql },
  { patron: ruta(`/limpieza/descargar/${UUID}/[\\w-]+`), nombre: 'Sábana limpia', tipo: 'exportar', sql: limpiezaSql },
  { patron: ruta(`/georeferenciacion/eliminar/${UUID}`), nombre: 'Georreferenciación', tipo: 'eliminar', sql: georeferenciacionSql },
  { patron: ruta(`/georeferenciacion/(?:exportar|exportar-xlsx)/${UUID}`), nombre: 'Georreferenciación', tipo: 'exportar', sql: georeferenciacionSql },
  { patron: ruta(`/imagenes/eliminar/${UUID}`), nombre: 'Imagen', tipo: 'eliminar', sql: imagenSql },
  { patron: ruta(`/imagenes/${UUID}/(enlace|revocar)`), nombre: 'Imagen', tipo: 'editar', sql: imagenSql },
  { patron: ruta(`/maigret/eliminar/${UUID}`), nombre: 'Búsqueda Maigret', tipo: 'eliminar', sql: maigretSql },
  { patron: ruta(`/maigret/${UUID}/(?:reporte|pdf)`), nombre: 'Búsqueda Maigret', tipo: 'exportar', sql: maigretSql },
  { patron: ruta(`/spiderfoot/eliminar/${UUID}`), nombre: 'Búsqueda SpiderFoot', tipo: 'eliminar', sql: spiderfootSql },
  { patron: ruta(`/spiderfoot/detener/${UUID}`), nombre: 'Búsqueda SpiderFoot', tipo: 'editar', sql: spiderfootSql },
  { patron: ruta(`/spiderfoot/${UUID}/csv`), nombre: 'Búsqueda SpiderFoot', tipo: 'exportar', sql: spiderfootSql },
];

// The record a request touches, with a reader that never fails (an unreadable record logs without values).
// ctx: { pool, userId } of the signed-in user.
export function registroAuditado(req, path, ctx) {
  if (!ctx?.pool || !ctx.userId) return null;
  for (const spec of registrosAuditados) {
    const match = path.match(spec.patron);
    if (!match) continue;
    const sql = typeof spec.sql === 'function' ? spec.sql(match, req) : spec.sql;
    if (!sql) return null;
    const valores = (spec.valores || deRuta)(match, ctx);
    return {
      tipo: spec.tipo,
      nombre: typeof spec.nombre === 'function' ? spec.nombre(match, req) : spec.nombre,
      id: valores[0],
      porSesion: spec.valores === deSesion,
      leer: () => Promise.resolve()
        .then(() => ctx.pool.query(sql, valores))
        .then(([rows]) => rows[0] || null, () => null),
    };
  }
  return null;
}

const recortar = (texto, max = MAX_VALOR) => (texto.length > max ? `${texto.slice(0, max - 1)}…` : texto);

// One line of plain text for any value a query or a form returns.
export function valorTexto(value) {
  if (value === null || value === undefined || value === '') return VACIO;
  if (Buffer.isBuffer(value)) return '(archivo)';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? VACIO : value.toISOString().slice(0, 19).replace('T', ' ');
  if (Array.isArray(value)) return value.length ? recortar(value.map(valorTexto).join(', ')) : VACIO;
  if (typeof value === 'object') {
    const partes = Object.entries(value).map(([key, item]) => `${key}: ${valorTexto(item)}`);
    return partes.length ? recortar(partes.join(', ')) : VACIO;
  }
  return recortar(String(value).replace(/\s*\r?\n\s*/g, ' / ').trim()) || VACIO;
}

const json = (value) => {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch { return undefined; }
};

// Field → text. A column holding a JSON object (preferences) becomes one field per key.
function aplanar(row) {
  const campos = {};
  for (const [key, value] of Object.entries(row || {})) {
    const parsed = json(value);
    if (parsed && !Array.isArray(parsed)) {
      for (const [sub, item] of Object.entries(parsed)) campos[`${key} · ${sub}`] = valorTexto(item);
    } else {
      campos[key] = valorTexto(parsed ?? value);
    }
  }
  return campos;
}

export function describirCambios(tipo, antes, despues) {
  if (tipo === 'exportar' || (!antes && !despues)) return null;
  if (tipo === 'eliminar') {
    if (!antes) return null;
    if (despues) return 'El registro no se eliminó.';
    const lineas = Object.entries(aplanar(antes))
      .filter(([key, value]) => !SECRETOS.has(key) && value !== VACIO)
      .map(([key, value]) => `${key}: ${value}`);
    return ['Datos eliminados:', ...lineas].join('\n');
  }
  const a = aplanar(antes);
  const d = aplanar(despues);
  const lineas = [...new Set([...Object.keys(a), ...Object.keys(d)])]
    .filter((key) => (a[key] ?? VACIO) !== (d[key] ?? VACIO))
    .map((key) => (SECRETOS.has(key) ? `${key}: se cambió` : `${key}: ${a[key] ?? VACIO} → ${d[key] ?? VACIO}`));
  return lineas.length ? lineas.join('\n') : 'Sin cambios en los datos.';
}

// "Línea #12 · 6621234567": the type, the numeric id and the record's first field.
export function describirRegistro(registro, antes, despues) {
  const fila = antes || despues;
  const primero = fila && Object.entries(fila).find(([key, value]) => !SECRETOS.has(key) && valorTexto(value) !== VACIO);
  const id = !registro.porSesion && /^\d+$/.test(String(registro.id)) ? ` #${registro.id}` : '';
  return recortar([`${registro.nombre}${id}`, primero && recortar(valorTexto(primero[1]), 80)].filter(Boolean).join(' · '), MAX_REGISTRO);
}

// Fields that name what a form creates, in order of preference.
const camposQueNombran = ['numObjetivo', 'numero', 'linea', 'imei', 'nuc', 'titulo', 'nombre', 'email', 'username', 'usuario', 'target', 'objetivo'];

// For actions without a listed record: the uploaded files, a field that names the record, or the id in the path.
export function registroDeSolicitud(path, body, files = []) {
  if (files.length) return recortar(`Archivo: ${files.map((file) => file.originalname).join(', ')}`, MAX_REGISTRO);
  const campo = camposQueNombran.find((key) => ['string', 'number'].includes(typeof body?.[key]) && String(body[key]).trim() !== '');
  if (campo) return recortar(`${campo}: ${valorTexto(body[campo])}`, MAX_REGISTRO);
  const id = path.match(/\/(\d+)(?:\/|$)/);
  return id ? `#${id[1]}` : null;
}
