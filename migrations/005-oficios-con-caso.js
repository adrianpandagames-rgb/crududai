import { columnExists, foreignKeyExists, quoteName, tableExists } from './helpers.js';

// The office tables keep their own fields and gain what links them: the NUC's year and its case, the catalog
// delito (Recepciones has none) and the user who created the record as a real reference. Signers stay as text,
// since they need not have an account. Existing records get a case only when their NUC belongs to exactly one;
// the rest wait for someone to set the year when editing them.
export const OFICIOS = [
  { table: 'Identificaciones', delito: true },
  { table: 'DatosConservados', delito: true },
  { table: 'Recepciones', delito: false },
  { table: 'Extracciones', delito: true },
  { table: 'Inspecciones', delito: true },
  { table: 'OficiosVarios', delito: true },
  { table: 'ViaAlcance', delito: true },
];
// CarpetasResguardo records who added each folder, like the office tables.
const CREADORES = [...OFICIOS.map(({ table }) => table), 'CarpetasResguardo'];

// Kept here rather than imported, so the migration stays as it ran even if the app's rule changes.
const normalizarDelito = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);

const columnType = async (db, table, column) => {
  const [rows] = await db.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      AND IF(@@lower_case_table_names = 0, BINARY TABLE_NAME = ?, TABLE_NAME = LOWER(?)) AND COLUMN_NAME = ?`,
    [table, table, column],
  );
  return rows[0] || null;
};

export default {
  id: '005-oficios-con-caso',
  descripcion: 'Enlaza los oficios con su caso (año del NUC), su delito y el usuario que los creó; agrega la carpeta resguardo de Inspecciones.',
  async check(db) {
    const problems = [];
    for (const table of CREADORES) {
      if (!await tableExists(db, table)) {
        problems.push(`no existe la tabla ${table}.`);
        continue;
      }
      const [[{ n }]] = await db.query(
        `SELECT COUNT(*) AS n FROM ${quoteName(table)} t LEFT JOIN users u ON u.id = t.creado_por WHERE u.id IS NULL`,
      );
      if (Number(n)) problems.push(`${table} tiene ${n} registros creados por un usuario que no existe.`);
    }
    for (const { table } of OFICIOS) {
      if (!await tableExists(db, table)) continue;
      const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${quoteName(table)} WHERE CHAR_LENGTH(TRIM(nuc)) > 50`);
      if (Number(n)) problems.push(`${table} tiene ${n} NUC de más de 50 caracteres.`);
    }
    // casos and delitos come from migration 004, which always runs first; in a fresh run they do not exist yet.
    return problems;
  },
  async up(db, { log }) {
    // The code saves Inspecciones.carpeta_resguardo, but the script that added it never ran on the server, so
    // no inspection could be saved there.
    if (!await columnExists(db, 'Inspecciones', 'carpeta_resguardo')) {
      await db.query('ALTER TABLE Inspecciones ADD COLUMN carpeta_resguardo VARCHAR(255) NULL');
      log('  Agregada Inspecciones.carpeta_resguardo.');
    }

    const [[{ tipoUsuario }]] = await db.query(
      "SELECT COLUMN_TYPE AS tipoUsuario FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'id'",
    );

    for (const { table, delito } of OFICIOS) {
      const t = quoteName(table);
      if (!await columnExists(db, table, 'ano')) await db.query(`ALTER TABLE ${t} ADD COLUMN ano YEAR NULL AFTER nuc`);
      if (!await columnExists(db, table, 'caso_id')) {
        await db.query(`ALTER TABLE ${t} ADD COLUMN caso_id INT NULL AFTER ano, ADD INDEX ${quoteName(`${table}_caso_id`)} (caso_id)`);
      }
      if (delito && !await columnExists(db, table, 'delito_id')) {
        await db.query(`ALTER TABLE ${t} ADD COLUMN delito_id INT NULL AFTER delito, ADD INDEX ${quoteName(`${table}_delito_id`)} (delito_id)`);
      }

      // A NUC that belongs to a single case gives the record its year; otherwise it stays without a case.
      await db.query(`UPDATE ${t} o JOIN (SELECT nuc, MIN(ano) AS ano, MIN(id) AS id FROM casos GROUP BY nuc HAVING COUNT(*) = 1) c
        ON c.nuc = TRIM(o.nuc) SET o.ano = c.ano, o.caso_id = c.id WHERE o.caso_id IS NULL`);

      if (delito) {
        const [usados] = await db.query(`SELECT DISTINCT delito FROM ${t} WHERE delito IS NOT NULL AND TRIM(delito) <> '' AND delito_id IS NULL`);
        for (const { delito: texto } of usados) {
          const nombre = normalizarDelito(texto);
          await db.query('INSERT IGNORE INTO delitos (nombre) VALUES (?)', [nombre]);
          await db.query(`UPDATE ${t} SET delito_id = (SELECT id FROM delitos WHERE nombre = ?) WHERE delito = ? AND delito_id IS NULL`, [nombre, texto]);
        }
        if (!await foreignKeyExists(db, table, `${table}_delito`)) {
          await db.query(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteName(`${table}_delito`)} FOREIGN KEY (delito_id) REFERENCES delitos (id)`);
        }
      }
      if (!await foreignKeyExists(db, table, `${table}_caso`)) {
        await db.query(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteName(`${table}_caso`)} FOREIGN KEY (caso_id) REFERENCES casos (id)`);
      }
    }

    // creado_por had a different integer type than users.id, which MySQL needs to match for a foreign key.
    for (const table of CREADORES) {
      const t = quoteName(table);
      const actual = await columnType(db, table, 'creado_por');
      if (actual && (actual.type !== tipoUsuario || actual.nullable !== 'NO')) {
        await db.query(`ALTER TABLE ${t} MODIFY COLUMN creado_por ${tipoUsuario} NOT NULL`);
      }
      if (!await foreignKeyExists(db, table, `${table}_creado_por`)) {
        await db.query(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteName(`${table}_creado_por`)} FOREIGN KEY (creado_por) REFERENCES users (id)`);
      }
    }

    const resumen = [];
    for (const { table } of OFICIOS) {
      const [[{ total, conCaso }]] = await db.query(`SELECT COUNT(*) AS total, COUNT(caso_id) AS conCaso FROM ${quoteName(table)}`);
      if (Number(total)) resumen.push(`${table}: ${conCaso} de ${total} con caso`);
    }
    log(`  ${resumen.length ? resumen.join('; ') : 'Sin oficios registrados'}.`);
  },
};
