// Clasificación compartida por la consulta y los filtros, también para el historial.
export const auditResources = {
  UBICACION: 'Ubicación', RUTA: 'Ruta', DATOS: 'Datos conservados', IMEI: 'IMEI',
  LINEA: 'Línea', USUARIO: 'Usuario', IDENTIFICACION: 'Identificación',
  RECEPCION: 'Recepción', EXTRACCION: 'Extracción', INSPECCION: 'Inspección',
  OFICIO: 'Oficio vario', ALCANCE: 'Vía alcance', CARPETA: 'Carpeta',
  ESTUDIANTE: 'Estudiante', OTRO: 'Otro',
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
  WHEN method IN ('LOGIN', 'LOGIN_FAILED', 'SEARCH') THEN method
  WHEN method = 'DELETE' OR LOWER(request_path) REGEXP '/(eliminar|delete)(/|$)' THEN 'ELIMINADO'
  WHEN method IN ('PUT', 'PATCH')
    OR LOWER(request_path) REGEXP '/(editar|update|restablecer-contrasena|rol|estado)(/|$)'
    OR LOWER(request_path) LIKE '/metricas/registros/%'
    OR LOWER(request_path) = '/cambiar-contrasena' THEN 'EDITADO'
  WHEN method = 'POST' THEN 'REGISTRO'
  ELSE 'OTRO' END`;

export const auditResourceSql = `CASE
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
  ELSE 'OTRO' END`;

export const auditActionLabels = {
  LOGIN: 'Inicio de sesión', LOGIN_FAILED: 'Intento de sesión fallido', SEARCH: 'Búsqueda',
  REGISTRO: 'Creado', EDITADO: 'Editado', ELIMINADO: 'Eliminado',
  OTRO: 'Otra acción',
};

export function describeAuditAction(entry) {
  return auditActionLabels[entry.operation] || 'Otra acción';
}
