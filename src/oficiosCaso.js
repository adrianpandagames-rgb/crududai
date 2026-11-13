import { casoIdPara, delitoPara, normalizarNuc } from './casosService.js';

// Every office record belongs to a case, which is a NUC within a year (see migration 004), so the forms ask
// for the NUC's year. Its delito goes through the open catalog, as in the lines. Recepciones has no delito.
const TABLAS_SIN_DELITO = new Set(['Recepciones']);
export const CAMPO_ANO_NUC = ['ano', 'Año del NUC', 'number'];

export function validarAnoNuc(valor, hoy = new Date()) {
  const texto = typeof valor === 'number' ? String(valor) : typeof valor === 'string' ? valor.trim() : '';
  const maximo = hoy.getFullYear() + 1;
  if (!/^\d{4}$/.test(texto) || Number(texto) < 2000 || Number(texto) > maximo) {
    throw new Error(`Año del NUC: indica un año entre 2000 y ${maximo}.`);
  }
  return Number(texto);
}

// Wraps a form validator so the result also carries the NUC's year.
export const conAnoNuc = (validar) => (body = {}) => {
  const datos = validar(body);
  return { ...datos, ano: validarAnoNuc(body.ano) };
};

// The field list of a form with the year right after the NUC; extra entries of a field (like Datos
// Conservados' "optional" flag) are filled so the year is required.
export const insertarAnoNuc = (campos) => campos.flatMap((campo) => (
  campo[0] === 'nuc' ? [campo, [...CAMPO_ANO_NUC, ...campo.slice(3).map(() => false)]] : [campo]
));

// Points a saved record to its case and catalog delito; the delito text keeps the catalog's spelling.
export async function enlazarOficio(db, tabla, id, datos) {
  const casoId = await casoIdPara(db, datos.nuc, datos.ano);
  if (TABLAS_SIN_DELITO.has(tabla)) {
    await db.execute(`UPDATE ${tabla} SET ano = ?, caso_id = ? WHERE id = ?`, [datos.ano, casoId, id]);
    return;
  }
  const delito = await delitoPara(db, datos.delito);
  await db.execute(
    `UPDATE ${tabla} SET ano = ?, caso_id = ?, delito = ?, delito_id = ? WHERE id = ?`,
    [datos.ano, casoId, delito.nombre, delito.id, id],
  );
}

// Runs `fn` on one connection inside a transaction when `db` is a pool, so a record and its links are saved
// together; a plain connection is used as given.
export async function enTransaccion(db, fn) {
  if (typeof db.getConnection !== 'function') return fn(db);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// The years in which that NUC already has a case, newest first; the form fills the year when there is one.
export async function anosDelNuc(db, nuc) {
  const numero = normalizarNuc(nuc);
  if (!numero || numero.length > 50) return [];
  const [rows] = await db.query('SELECT ano FROM casos WHERE nuc = ? ORDER BY ano DESC', [numero]);
  return rows.map((row) => Number(row.ano));
}
