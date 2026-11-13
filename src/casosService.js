// A case is a NUC within a year; delitos are an open catalog of the wordings in use (see migration 004).
// `db` may be the pool or a connection inside a transaction.
import { lineKey } from '../public/js/planeacion-contactos.js';

export const normalizarNuc = (nuc) => String(nuc ?? '').trim();
export const normalizarDelito = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);

// LAST_INSERT_ID(id) makes insertId the existing row's id when the unique key already holds the value.
const upsertId = async (db, sql, params) => {
  const [result] = await db.query(sql, params);
  return result.insertId;
};

// The case of that NUC and year, created on first use; null without either.
export async function casoIdPara(db, nuc, ano) {
  const numero = normalizarNuc(nuc);
  if (!numero || !ano) return null;
  return upsertId(db, 'INSERT INTO casos (nuc, ano) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [numero, ano]);
}

// The line of that number within the case (see migration 006), created on first use; null without a case or
// without a phone number (the "sin utilidad" IMEI).
export async function lineaIdPara(db, casoId, numero) {
  const linea = lineKey(numero);
  if (!casoId || !linea) return null;
  return upsertId(db, 'INSERT INTO lineas (caso_id, numero) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [casoId, linea]);
}

// Case and line of a registration, as stored in objetivo and objetivoImei.
export async function casoYLineaPara(db, numero, nuc, ano) {
  const casoId = await casoIdPara(db, nuc, ano);
  return { casoId, lineaId: await lineaIdPara(db, casoId, numero) };
}

// The catalog entry for that wording, added when new. `nombre` is the catalog's spelling, which wins over
// differences in spaces, case or accents; both are null for an empty delito.
export async function delitoPara(db, texto) {
  const nombre = normalizarDelito(texto);
  if (!nombre) return { id: null, nombre: null };
  const id = await upsertId(db, 'INSERT INTO delitos (nombre) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [nombre]);
  const [[row]] = await db.query('SELECT nombre FROM delitos WHERE id = ?', [id]);
  return { id, nombre: row.nombre };
}

export async function listarDelitos(db) {
  const [rows] = await db.query('SELECT nombre FROM delitos ORDER BY nombre');
  return rows.map((row) => row.nombre);
}
