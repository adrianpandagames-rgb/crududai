// Read-only views that gather what the app holds about a phone line or a case (NUC + year), using the links of
// migrations 004-006. Each source keeps the visibility rules of its own module:
// - lines, contacts and IMEI are open to every signed-in user, as in Líneas and IMEI; that includes the
//   crossing of contacts between objectives (a decision of the unit, although Red telefónica stays admin-only);
// - office records are hidden from UECS users, who cannot open Métricas;
// - profiles and uploaded files are filtered by the viewer's group, and Georeferenciación only shows to
//   administrators and UECS users, who are the only ones allowed into that module.
import { lineKey } from '../public/js/planeacion-contactos.js';
import { visibleFiles } from './fileGroups.js';
import { fuentesMetricas } from './metricasService.js';

// Contacts are stored as digits (with or without the 52 prefix) or as "sin utilidad"; only numbers cross.
const CONTACTO_NUMERICO = "c.contacto REGEXP '^[0-9]{3,}$'";
const CONTACTO_KEY = 'RIGHT(c.contacto, 10)';
export const MAX_CONTACTOS_LISTADOS = 2000;

const puedeVerOficios = (session) => session?.role !== 'uecs';
const puedeVerGeoreferenciacion = (session) => session?.isAdmin === true || session?.role === 'uecs';

// A missing table (a module never opened on this server) means nothing to show, not a failure.
const opcional = async (consulta) => {
  try {
    return await consulta();
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE' || error?.code === 'ER_BAD_FIELD_ERROR') return [];
    throw error;
  }
};

// What the search box was given: a phone line (ten digits or more) or a NUC.
export function interpretarBusqueda(texto) {
  const valor = String(texto ?? '').trim().slice(0, 60);
  if (!valor) return { tipo: 'vacia' };
  const digits = valor.replace(/\D/g, '');
  if (digits.length >= 10 && /^[\d\s()+.-]+$/.test(valor)) return { tipo: 'linea', numero: lineKey(valor) };
  return { tipo: 'nuc', nuc: valor, numero: digits.length >= 7 && /^[\d\s()+.-]+$/.test(valor) ? lineKey(valor) : null };
}

export async function casosDelNuc(db, nuc) {
  const [rows] = await db.query('SELECT id, nuc, ano FROM casos WHERE nuc = ? ORDER BY ano DESC', [String(nuc).trim()]);
  return rows.map((row) => ({ ...row, ano: Number(row.ano) }));
}

export async function casoPorNucAno(db, nuc, ano) {
  const [rows] = await db.query('SELECT id FROM casos WHERE nuc = ? AND ano = ?', [String(nuc ?? '').trim(), ano]);
  return rows[0]?.id ?? null;
}

const archivosDeLinea = async (db, session, numero) => {
  const porLinea = (alias) => `RIGHT(REGEXP_REPLACE(${alias}.line_number, '[^0-9]', ''), 10) = ?`;
  const ruta = visibleFiles(session, 'r');
  const limpieza = visibleFiles(session, 'l');
  const geo = visibleFiles(session, 'g');
  const [rutas, limpiezas, georeferencias] = await Promise.all([
    opcional(async () => (await db.query(`SELECT r.file_uuid AS id, r.original_name AS nombre, r.status AS estado,
        DATE_FORMAT(r.created_at, '%Y-%m-%d') AS fecha FROM ruta_archivos r
      WHERE ${ruta.where} AND r.expires_at > NOW() AND ${porLinea('r')} ORDER BY r.id DESC LIMIT 50`, [...ruta.values, numero]))[0]),
    opcional(async () => (await db.query(`SELECT l.file_uuid AS id, l.original_name AS nombre,
        DATE_FORMAT(l.created_at, '%Y-%m-%d') AS fecha FROM limpieza_archivos l
      WHERE ${limpieza.where} AND l.expires_at > NOW() AND ${porLinea('l')} ORDER BY l.id DESC LIMIT 50`, [...limpieza.values, numero]))[0]),
    puedeVerGeoreferenciacion(session)
      ? opcional(async () => (await db.query(`SELECT g.file_uuid AS id, g.original_name AS nombre, g.status AS estado,
          DATE_FORMAT(g.created_at, '%Y-%m-%d') AS fecha FROM georeferenciacion_archivos g
        WHERE ${geo.where} AND g.expires_at > NOW() AND ${porLinea('g')} ORDER BY g.id DESC LIMIT 50`, [...geo.values, numero]))[0])
      : null,
  ]);
  return { rutas, limpiezas, georeferencias };
};

// Office records that list the number among their lines (Identificaciones and Datos Conservados keep them as a
// JSON list, Recepciones as free text), typed with or without spaces. The SQL filter compares the digits alone,
// which may join two numbers; each candidate is then checked number by number.
const oficiosQueMencionan = async (db, numero) => {
  const patron = `%${numero}%`;
  const fuentes = [
    ['Identificaciones', 'Identificación de línea', 'CAST(lineas_descritas AS CHAR)'],
    ['DatosConservados', 'Datos Conservados', 'CAST(lineas_descritas AS CHAR)'],
    ['Recepciones', 'Recepción', 'lineas'],
  ];
  const encontrados = [];
  for (const [tabla, tipo, columna] of fuentes) {
    const rows = await opcional(async () => (await db.query(`SELECT id, nuc, ano, caso_id AS casoId, ${columna} AS lineas,
        DATE_FORMAT(fecha_envio, '%Y-%m-%d') AS fecha FROM ${tabla} WHERE REGEXP_REPLACE(${columna}, '[^0-9]', '') LIKE ?
        ORDER BY id DESC LIMIT 200`, [patron]))[0]);
    for (const row of rows) {
      let lineas = [];
      try { lineas = tabla === 'Recepciones' ? String(row.lineas ?? '').split(/[,;\n/]+/) : JSON.parse(row.lineas ?? '[]'); } catch { lineas = []; }
      if (Array.isArray(lineas) && lineas.some((linea) => lineKey(linea) === numero)) {
        encontrados.push({ tipo, id: row.id, nuc: row.nuc, ano: row.ano ? Number(row.ano) : null, casoId: row.casoId, fecha: row.fecha });
      }
    }
  }
  return encontrados;
};

export async function fichaLinea(db, session, valor, { perfiles } = {}) {
  const numero = lineKey(valor);
  if (!numero) return null;

  const [lineas] = await db.query(`SELECT l.id, l.caso_id AS casoId, c.nuc, c.ano FROM lineas l JOIN casos c ON c.id = l.caso_id
    WHERE l.numero = ? ORDER BY c.ano DESC, c.nuc`, [numero]);
  const ids = lineas.map((linea) => linea.id);
  const enLineas = ids.length ? ids : [0];

  const [registros] = await db.query(`SELECT o.idObjetivo AS id, o.linea_id AS lineaId, o.tipo, o.delito,
      DATE_FORMAT(o.created_at, '%Y-%m-%d') AS fecha,
      (SELECT COUNT(*) FROM contactos c WHERE c.idObjetivo = o.idObjetivo) AS contactos
    FROM objetivo o WHERE o.linea_id IN (?) ORDER BY o.created_at, o.idObjetivo`, [enLineas]);
  const [imeis] = await db.query(`SELECT i.imei, i.brand_name AS marca, i.modelo, x.linea_id AS lineaId, x.tipo
    FROM imei i JOIN objetivoImei x ON x.idObjetivo = i.idObjetivo WHERE x.linea_id IN (?) ORDER BY i.imei`, [enLineas]);

  // This line's own contacts, merged by their national number.
  const [propios] = await db.query(`SELECT ${CONTACTO_KEY} AS numero, COUNT(DISTINCT o.idObjetivo) AS registros
    FROM contactos c JOIN objetivo o ON o.idObjetivo = c.idObjetivo
    WHERE o.linea_id IN (?) AND ${CONTACTO_NUMERICO} GROUP BY numero ORDER BY numero`, [enLineas]);
  const contactos = propios.map((row) => ({ numero: row.numero, registros: Number(row.registros), cruces: [], esObjetivo: false }));

  // Which of them are also contacts of other objective lines, or objective lines themselves.
  if (contactos.length) {
    const claves = contactos.map((contacto) => contacto.numero);
    // The alias must not be "numero": GROUP BY and DISTINCT would take lineas.numero instead.
    const [cruces] = await db.query(`SELECT DISTINCT ${CONTACTO_KEY} AS contacto, l.numero AS linea, cs.id AS casoId, cs.nuc, cs.ano
      FROM contactos c JOIN objetivo o ON o.idObjetivo = c.idObjetivo JOIN lineas l ON l.id = o.linea_id JOIN casos cs ON cs.id = l.caso_id
      WHERE ${CONTACTO_KEY} IN (?) AND ${CONTACTO_NUMERICO} AND l.numero <> ?
      ORDER BY cs.ano DESC, l.numero`, [claves, numero]);
    const [objetivos] = await db.query('SELECT DISTINCT numero FROM lineas WHERE numero IN (?)', [claves]);
    const porNumero = new Map(contactos.map((contacto) => [contacto.numero, contacto]));
    for (const cruce of cruces) porNumero.get(cruce.contacto)?.cruces.push({ linea: cruce.linea, casoId: cruce.casoId, nuc: cruce.nuc, ano: Number(cruce.ano) });
    for (const { numero: objetivo } of objetivos) if (porNumero.has(objetivo)) porNumero.get(objetivo).esObjetivo = true;
  }
  const contactosCruzados = contactos.filter((contacto) => contacto.cruces.length || contacto.esObjetivo)
    .sort((a, b) => b.cruces.length - a.cruces.length || a.numero.localeCompare(b.numero));

  // Objective lines that have this number among their contacts.
  const [comoContacto] = await db.query(`SELECT l.numero AS linea, cs.id AS casoId, cs.nuc, cs.ano, COUNT(DISTINCT o.idObjetivo) AS registros
    FROM contactos c JOIN objetivo o ON o.idObjetivo = c.idObjetivo JOIN lineas l ON l.id = o.linea_id JOIN casos cs ON cs.id = l.caso_id
    WHERE ${CONTACTO_KEY} = ? AND ${CONTACTO_NUMERICO} AND l.numero <> ?
    GROUP BY l.id, l.numero, cs.id, cs.nuc, cs.ano ORDER BY cs.ano DESC, l.numero`, [numero, numero]);

  const [perfilesEncontrados, archivos, oficios] = await Promise.all([
    perfiles ? perfiles.search(numero, session).then((rows) => rows.filter((row) => lineKey(row.linea) === numero)) : [],
    archivosDeLinea(db, session, numero),
    puedeVerOficios(session) ? oficiosQueMencionan(db, numero) : null,
  ]);

  return {
    numero,
    casos: lineas.map((linea) => ({
      ...linea,
      ano: Number(linea.ano),
      registros: registros.filter((registro) => registro.lineaId === linea.id),
      imeis: imeis.filter((imei) => imei.lineaId === linea.id),
    })),
    totalContactos: contactos.length,
    contactos: contactos.slice(0, MAX_CONTACTOS_LISTADOS),
    contactosCruzados,
    comoContacto: comoContacto.map((row) => ({ ...row, ano: Number(row.ano), registros: Number(row.registros) })),
    perfiles: perfilesEncontrados,
    archivos,
    oficios,
  };
}

export async function fichaCaso(db, session, casoId) {
  const [[caso]] = await db.query('SELECT id, nuc, ano FROM casos WHERE id = ?', [casoId]);
  if (!caso) return null;
  caso.ano = Number(caso.ano);

  const [otrosAnos] = await db.query('SELECT id, ano FROM casos WHERE nuc = ? AND id <> ? ORDER BY ano DESC', [caso.nuc, caso.id]);
  const [lineas] = await db.query(`SELECT l.id, l.numero,
      (SELECT COUNT(*) FROM objetivo o WHERE o.linea_id = l.id) AS registros,
      (SELECT GROUP_CONCAT(DISTINCT o.tipo ORDER BY o.tipo SEPARATOR ', ') FROM objetivo o WHERE o.linea_id = l.id) AS tipos,
      (SELECT MIN(DATE_FORMAT(o.created_at, '%Y-%m-%d')) FROM objetivo o WHERE o.linea_id = l.id) AS desde,
      (SELECT COUNT(DISTINCT c.contacto) FROM contactos c JOIN objetivo o ON o.idObjetivo = c.idObjetivo
        WHERE o.linea_id = l.id AND ${CONTACTO_NUMERICO}) AS contactos,
      (SELECT COUNT(*) FROM imei i JOIN objetivoImei x ON x.idObjetivo = i.idObjetivo WHERE x.linea_id = l.id) AS imeis
    FROM lineas l WHERE l.caso_id = ? ORDER BY l.numero`, [caso.id]);

  // Contacts shared by two or more lines of the case.
  const [enComun] = await db.query(`SELECT ${CONTACTO_KEY} AS contacto, COUNT(DISTINCT o.linea_id) AS lineas,
      GROUP_CONCAT(DISTINCT l.numero ORDER BY l.numero SEPARATOR ', ') AS deLineas
    FROM contactos c JOIN objetivo o ON o.idObjetivo = c.idObjetivo JOIN lineas l ON l.id = o.linea_id
    WHERE l.caso_id = ? AND ${CONTACTO_NUMERICO}
    GROUP BY contacto HAVING lineas > 1 ORDER BY lineas DESC, contacto LIMIT 500`, [caso.id]);

  const [delitos] = await db.query(`SELECT DISTINCT d.nombre FROM delitos d
    WHERE d.id IN (SELECT delito_id FROM objetivo WHERE caso_id = ?) ORDER BY d.nombre`, [caso.id]);

  let oficios = null;
  let oficiosSinAno = null;
  if (puedeVerOficios(session)) {
    oficios = [];
    oficiosSinAno = [];
    for (const { tabla, tipo } of fuentesMetricas) {
      // Records of this case, plus those with the same NUC still waiting for their year.
      const [rows] = await db.query(`SELECT id, caso_id AS casoId, DATE_FORMAT(fecha_envio, '%Y-%m-%d') AS fecha FROM ${tabla}
        WHERE caso_id = ? OR (caso_id IS NULL AND TRIM(nuc) = ?) ORDER BY fecha_envio DESC, id DESC`, [caso.id, caso.nuc]);
      for (const row of rows) (row.casoId ? oficios : oficiosSinAno).push({ tipo, id: row.id, fecha: row.fecha });
      if (tabla === 'Recepciones') continue;
      const [nombres] = await db.query(`SELECT DISTINCT d.nombre FROM delitos d JOIN ${tabla} t ON t.delito_id = d.id WHERE t.caso_id = ?`, [caso.id]);
      for (const { nombre } of nombres) if (!delitos.some((d) => d.nombre === nombre)) delitos.push({ nombre });
    }
  }

  return {
    ...caso,
    otrosAnos: otrosAnos.map((row) => ({ ...row, ano: Number(row.ano) })),
    lineas: lineas.map((row) => ({ ...row, registros: Number(row.registros), contactos: Number(row.contactos), imeis: Number(row.imeis) })),
    enComun: enComun.map((row) => ({ numero: row.contacto, deLineas: row.deLineas, lineas: Number(row.lineas) })),
    delitos: delitos.map((row) => row.nombre).sort((a, b) => a.localeCompare(b)),
    oficios,
    oficiosSinAno,
  };
}
