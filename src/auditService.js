import { auditOperationSql, auditResourceSql, auditResources, describeAuditAction } from './auditActions.js';
import { AUDIT_PAGE_SIZE, auditResults, formatAuditTimestamp } from './auditFilters.js';
import { presentAuditEntry } from './auditPresentation.js';

export const AUDIT_EXPORT_LIMIT = 10000;

const entryColumns = `user_email, method, request_path, status_code, ip_address, details,
  ${auditOperationSql} AS operation, ${auditResourceSql} AS resource,
  UNIX_TIMESTAMP(created_at) AS createdTs`;

export function auditResultOf(statusCode) {
  const status = Number(statusCode);
  if (status >= 500) return 'ERROR';
  if ([401, 403, 429].includes(status)) return 'DENEGADO';
  if (status >= 400) return 'RECHAZADO';
  return 'OK';
}

const presentRow = (row) => {
  const entry = presentAuditEntry({ ...row, createdAt: formatAuditTimestamp(row.createdTs) });
  const result = auditResultOf(entry.status_code);
  return {
    ...entry,
    action: describeAuditAction(entry),
    section: auditResources[entry.resource] || 'Otro',
    result,
    resultLabel: Number(entry.status_code) === 304 ? 'Correcto (caché)' : auditResults[result],
  };
};

const andWhere = (where, clause) => (where ? `${where} AND ${clause}` : `WHERE ${clause}`);

export async function consultarAuditoria(pool, { where, values }, page = 1) {
  const [[rows], [summaryRows], [failedRows], [users]] = await Promise.all([
    pool.query(
      `SELECT ${entryColumns} FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...values, AUDIT_PAGE_SIZE, (page - 1) * AUDIT_PAGE_SIZE],
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT user_email) AS usuarios,
              COALESCE(SUM(status_code >= 500), 0) AS errores,
              COALESCE(SUM(status_code IN (401, 403, 429)), 0) AS denegados,
              COALESCE(SUM(method = 'LOGIN_FAILED'), 0) AS fallidos
       FROM audit_logs ${where}`,
      values,
    ),
    pool.query(
      `SELECT COALESCE(ip_address, '') AS ip, COUNT(*) AS intentos, COUNT(DISTINCT user_email) AS cuentas,
              MAX(UNIX_TIMESTAMP(created_at)) AS ultimoTs
       FROM audit_logs ${andWhere(where, "method = 'LOGIN_FAILED'")}
       GROUP BY ip_address ORDER BY intentos DESC, ultimoTs DESC LIMIT 5`,
      values,
    ),
    pool.query("SELECT DISTINCT user_email FROM audit_logs WHERE user_email <> '' ORDER BY user_email"),
  ]);

  const summary = Object.fromEntries(Object.entries(summaryRows[0] || {}).map(([key, value]) => [key, Number(value) || 0]));
  return {
    entries: rows.map(presentRow),
    summary,
    failedByIp: failedRows.map(({ ip, intentos, cuentas, ultimoTs }) => ({
      ip, intentos: Number(intentos) || 0, cuentas: Number(cuentas) || 0, ultimo: formatAuditTimestamp(ultimoTs),
    })),
    users,
    page,
    totalPages: Math.max(Math.ceil(summary.total / AUDIT_PAGE_SIZE), 1),
  };
}

// Spreadsheet apps run cells starting with these characters as formulas.
const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export async function exportarAuditoriaCsv(pool, { where, values }) {
  const [rows] = await pool.query(
    `SELECT ${entryColumns} FROM audit_logs ${where} ORDER BY id DESC LIMIT ?`,
    [...values, AUDIT_EXPORT_LIMIT],
  );
  const header = ['Fecha', 'Usuario', 'Sección', 'Origen', 'Acción', 'Qué buscó / parámetros', 'Ruta', 'Estado', 'Resultado', 'IP'];
  const lines = rows.map(presentRow).map((entry) => [
    `${entry.day} ${entry.time}`, entry.user_email, entry.section, entry.origin, entry.action,
    entry.searched, entry.request_path, entry.status_code, entry.resultLabel, entry.ip_address || '',
  ].map(csvCell).join(','));
  // The BOM makes Excel open the file as UTF-8 so accents survive.
  return { csv: `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, rows: rows.length };
}
