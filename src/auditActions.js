// Clasificación compartida por la consulta y los filtros, también para el historial.
export const auditResources = {
  UBICACION: 'Ubicación', RUTA: 'Ruta', DATOS: 'Datos conservados', IMEI: 'IMEI',
  LINEA: 'Línea', USUARIO: 'Usuario', IDENTIFICACION: 'Identificación',
  RECEPCION: 'Recepción', EXTRACCION: 'Extracción', INSPECCION: 'Inspección',
  OFICIO: 'Oficio vario', ALCANCE: 'Vía alcance', CARPETA: 'Carpeta',
  ESTUDIANTE: 'Estudiante', OTRO: 'Otro',
  GEOREFERENCIACION: 'Georreferenciación', PLANEACION: 'Planeación geográfica',
  TELEFONO: 'Teléfono', RED: 'Red telefónica', AUDITORIA: 'Auditoría', METRICAS: 'Métricas',
  MAIGRET: 'Maigret', IMAGEN: 'Búsqueda por imagen', NOMBRE: 'RastroX',
  COINCIDENCIA: 'Coincidencias de antenas', PERFIL: 'Perfil', TAREA: 'Tarea',
};

const metricTypes = {
  'Identificación de línea': 'IDENTIFICACION', 'Datos Conservados': 'DATOS',
  'Recepción': 'RECEPCION', 'Extracción': 'EXTRACCION', 'Inspección': 'INSPECCION',
  'Oficios varios': 'OFICIO', 'Vía alcance': 'ALCANCE',
};

export function auditRequestPath(requestPath, query = {}) {
  if (/^\/metricas\/registros\/\d+\/?$/i.test(requestPath)
    && typeof query.tipo === 'string' && Object.hasOwn(metricTypes, query.tipo)) {
    return `${requestPath}?tipo=${encodeURIComponent(query.tipo)}`;
  }
  return requestPath;
}

export const auditOperationSql = `CASE
  WHEN method IN ('LOGIN', 'LOGIN_FAILED', 'SEARCH', 'CONSULTA') THEN method
  WHEN method = 'DELETE' OR LOWER(request_path) REGEXP '/(eliminar|delete)(/|$)' THEN 'ELIMINADO'
  WHEN method IN ('PUT', 'PATCH')
    OR LOWER(request_path) REGEXP '/(editar|modificar|update|restablecer-contrasena|rol|estado|mover|puesto)(/|$)'
    OR LOWER(request_path) LIKE '/metricas/registros/%'
    OR LOWER(request_path) = '/cambiar-contrasena' THEN 'EDITADO'
  WHEN method = 'POST' THEN 'REGISTRO'
  ELSE 'OTRO' END`;

export const auditResourceSql = `CASE
  WHEN LOWER(request_path) REGEXP '^/api/bot/linea(/|$)' THEN 'LINEA'
  WHEN LOWER(request_path) REGEXP '^/api/bot/imei(/|$)' THEN 'IMEI'
  WHEN LOWER(request_path) REGEXP '^/api/bot/antena(/|$)' THEN 'UBICACION'
  WHEN LOWER(request_path) REGEXP '^/api/bot/cobertura/ubicacion(/|$)' THEN 'GEOREFERENCIACION'
  WHEN LOWER(request_path) REGEXP '^/api/bot/cobertura(/|$)' THEN 'PLANEACION'
  WHEN LOWER(request_path) REGEXP '^/georeferenciacion(/|$)' THEN 'GEOREFERENCIACION'
  WHEN LOWER(request_path) REGEXP '^/planeacion-geografica(/|$)' THEN 'PLANEACION'
  WHEN LOWER(request_path) REGEXP '^/coincidencias(/|$)' THEN 'COINCIDENCIA'
  WHEN LOWER(request_path) REGEXP '^/(api/)?telefono(/|$)' THEN 'TELEFONO'
  WHEN LOWER(request_path) REGEXP '^/red-telefonica(/|$)' THEN 'RED'
  WHEN LOWER(request_path) REGEXP '^/maigret(/|$)' THEN 'MAIGRET'
  WHEN LOWER(request_path) REGEXP '^/imagenes(/|$)' THEN 'IMAGEN'
  WHEN LOWER(request_path) REGEXP '^/nombres(/|$)' THEN 'NOMBRE'
  WHEN LOWER(request_path) REGEXP '^/perfiles(/|$)' THEN 'PERFIL'
  WHEN LOWER(request_path) REGEXP '^/tareas(/|$)' THEN 'TAREA'
  WHEN LOWER(request_path) REGEXP '^/auditoria(/|$)' THEN 'AUDITORIA'
  WHEN LOWER(request_path) REGEXP '^/ubicaciones(/|$)' THEN 'UBICACION'
  WHEN LOWER(request_path) REGEXP '^/ruta(/|$)' THEN 'RUTA'
  WHEN LOWER(request_path) REGEXP '^/crud(/|$)' OR LOWER(request_path) = '/metricas/datos-conservados' THEN 'DATOS'
  WHEN LOWER(request_path) REGEXP '^/imei(/|$)' THEN 'IMEI'
  WHEN LOWER(request_path) REGEXP '^/lineas(/|$)' THEN 'LINEA'
  WHEN LOWER(request_path) REGEXP '^/usuarios(/|$)' OR LOWER(request_path) = '/cambiar-contrasena' THEN 'USUARIO'
  WHEN LOWER(request_path) = '/metricas/identificaciones' THEN 'IDENTIFICACION'
  WHEN LOWER(request_path) = '/metricas/recepciones' THEN 'RECEPCION'
  WHEN LOWER(request_path) = '/metricas/extracciones' THEN 'EXTRACCION'
  WHEN LOWER(request_path) = '/metricas/inspecciones' THEN 'INSPECCION'
  WHEN LOWER(request_path) = '/metricas/oficios-varios' THEN 'OFICIO'
  WHEN LOWER(request_path) = '/metricas/via-alcance' THEN 'ALCANCE'
  ${Object.entries(metricTypes).map(([type, resource]) =>
    `WHEN LOWER(request_path) LIKE '/metricas/registros/%?tipo=${encodeURIComponent(type).toLowerCase().replace(/%/g, '!%')}' ESCAPE '!' THEN '${resource}'`).join('\n  ')}
  WHEN LOWER(request_path) LIKE '/metricas/registros/%' THEN 'CARPETA'
  WHEN LOWER(request_path) REGEXP '^/estudiantes(/|$)' THEN 'ESTUDIANTE'
  WHEN LOWER(request_path) REGEXP '^/api/(ubicaciones|localidades)(/|$)' THEN 'UBICACION'
  WHEN LOWER(request_path) REGEXP '^/(metricas|medidores)(/|$)' THEN 'METRICAS'
  ELSE 'OTRO' END`;

export const auditActionLabels = {
  CONSULTA: 'Consulta de página o datos',
  LOGIN: 'Inicio de sesión', LOGIN_FAILED: 'Intento de sesión fallido', SEARCH: 'Búsqueda',
  REGISTRO: 'Creado', EDITADO: 'Editado', ELIMINADO: 'Eliminado',
  OTRO: 'Otra acción',
};

// Specific wording for the changes people make most often; the generic label covers the rest.
const specificActions = [
  [/^\/ubicaciones\/register\/?$/i, 'Registró ubicación'],
  [/^\/imei\/register\/?$/i, 'Registró IMEI'],
  [/^\/ruta\/importar\/?$/i, 'Importó ruta'],
  [/^\/(crud\/import-csv|importar)\/?$/i, 'Importó CSV'],
  [/^\/subir\/?$/i, 'Subió archivo'],
  [/^\/ruta\/eliminar\//i, 'Eliminó ruta'],
  [/^\/georeferenciacion\/importar\/?$/i, 'Importó georreferenciación'],
  [/^\/georeferenciacion\/eliminar\//i, 'Eliminó georreferenciación'],
  [/^\/imagenes\/subir\/?$/i, 'Subió imagen'],
  [/^\/imagenes\/eliminar\//i, 'Eliminó imagen'],
  [/^\/perfiles\/?$/i, 'Registró perfil'],
  [/^\/perfiles\/eliminar\//i, 'Eliminó perfil'],
  [/^\/tareas\/?$/i, 'Registró tarea'],
  [/^\/tareas\/\d+\/mover\/?$/i, 'Movió tarea'],
  [/^\/tareas\/eliminar\//i, 'Eliminó tarea'],
  [/^\/usuarios\/?$/i, 'Creó usuario'],
  [/^\/usuarios\/\d+\/rol\/?$/i, 'Cambió rol de usuario'],
  [/^\/usuarios\/\d+\/estado\/?$/i, 'Cambió estado de usuario'],
  [/^\/usuarios\/\d+\/puesto\/?$/i, 'Cambió puesto de usuario'],
  [/^\/usuarios\/\d+\/restablecer-contrasena\/?$/i, 'Restableció contraseña'],
  [/^\/usuarios\/\d+\/telegram\/?$/i, 'Vinculó Telegram'],
  [/^\/cambiar-contrasena\/?$/i, 'Cambió su contraseña'],
  [/^\/maigret\/?$/i, 'Búsqueda en Maigret'],
  [/^\/(medidores|usuarios)\/google-geocoding\/reiniciar\/?$/i, 'Reinició contador de Geocoding'],
  [/\/(editar|modificar)(\/|$)/i, 'Editó registro'],
];

export function describeAuditAction(entry) {
  if (!['CONSULTA', 'SEARCH', 'LOGIN', 'LOGIN_FAILED'].includes(entry.operation)) {
    const path = String(entry.request_path || '').split('?')[0];
    const match = specificActions.find(([pattern]) => pattern.test(path));
    if (match) return match[1];
  }
  return auditActionLabels[entry.operation] || 'Otra acción';
}
