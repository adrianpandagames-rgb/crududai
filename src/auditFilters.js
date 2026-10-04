import { auditActionLabels, auditResources, auditOperationSql, auditResourceSql } from './auditActions.js';
export { auditActionLabels } from './auditActions.js';

export function buildAuditFilters(query = {}) {
  const filters = {};
  for (const key of ['desde', 'hasta', 'tipo', 'accion', 'usuario']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      throw new Error('Los filtros deben contener un solo valor.');
    }
    filters[key] = (query[key] || '').trim();
  }
  for (const key of ['desde', 'hasta']) {
    const value = filters[key];
    if (!value) continue;
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1000-01-01' || value > '9999-12-30'
      || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error('Ingresa fechas válidas.');
    }
  }
  if (filters.desde && filters.hasta && filters.desde > filters.hasta) {
    throw new Error('La fecha inicial no puede ser posterior a la fecha final.');
  }
  if (filters.tipo && !Object.hasOwn(auditResources, filters.tipo)) {
    throw new Error('Selecciona un tipo válido.');
  }
  if (filters.accion && !Object.hasOwn(auditActionLabels, filters.accion)) {
    throw new Error('Selecciona una acción válida.');
  }
  if (filters.usuario.length > 255) throw new Error('El usuario es demasiado largo.');
  const clauses = [];
  const values = [];
  if (filters.desde) { clauses.push('created_at >= ?'); values.push(filters.desde); }
  if (filters.hasta) { clauses.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)'); values.push(filters.hasta); }
  if (filters.tipo) {
    clauses.push(`(${auditResourceSql}) = ?`);
    values.push(filters.tipo);
  }
  if (filters.accion) {
    clauses.push(`(${auditOperationSql}) = ?`);
    values.push(filters.accion);
  }
  if (filters.usuario) { clauses.push('user_email = ?'); values.push(filters.usuario); }
  return { filters, where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}
