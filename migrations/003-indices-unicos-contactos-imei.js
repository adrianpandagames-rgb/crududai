import { indexExists, quoteName, tableExists } from './helpers.js';

// A line cannot hold the same contact or IMEI twice. The imports already check before inserting; the index makes
// the database refuse it too, and lets lookups by line and value use it.
export const INDICES = [
  { table: 'contactos', index: 'contactos_objetivo_contacto', columns: ['idObjetivo', 'contacto'] },
  { table: 'imei', index: 'imei_objetivo_imei', columns: ['idObjetivo', 'imei'] },
];

export default {
  id: '003-indices-unicos-contactos-imei',
  descripcion: 'Impide repetir un contacto o un IMEI dentro de la misma línea.',
  async check(db) {
    const problems = [];
    for (const { table, index, columns } of INDICES) {
      if (!await tableExists(db, table)) problems.push(`no existe la tabla ${table}.`);
      else if (!await indexExists(db, table, index)) {
        const cols = columns.map(quoteName).join(', ');
        const [[{ n }]] = await db.query(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteName(table)} GROUP BY ${cols} HAVING COUNT(*) > 1) d`,
        );
        if (Number(n)) problems.push(`${table} tiene ${n} valores repetidos en la misma línea; hay que depurarlos antes.`);
      }
    }
    return problems;
  },
  async up(db, { log }) {
    for (const { table, index, columns } of INDICES) {
      if (await indexExists(db, table, index)) {
        log(`  ${index} ya existe.`);
        continue;
      }
      await db.query(`ALTER TABLE ${quoteName(table)} ADD UNIQUE KEY ${quoteName(index)} (${columns.map(quoteName).join(', ')})`);
      log(`  Creado ${index}.`);
    }
  },
};
