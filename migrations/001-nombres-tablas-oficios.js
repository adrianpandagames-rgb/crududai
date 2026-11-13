import { lowerCaseTableNames, quoteName, tableExists } from './helpers.js';

// The office tables arrived from a Windows dump in lower case, but the code names them in CamelCase; on Linux
// table names are case-sensitive, so Métricas could not find them. Windows and macOS servers fold the case
// themselves and are left alone.
export const TABLAS = ['DatosConservados', 'Extracciones', 'Identificaciones', 'Inspecciones', 'OficiosVarios', 'Recepciones', 'ViaAlcance'];

const renames = async (db) => {
  const pending = [];
  for (const name of TABLAS) {
    const lower = name.toLowerCase();
    if (await tableExists(db, lower) && !await tableExists(db, name)) pending.push([lower, name]);
  }
  return pending;
};

export default {
  id: '001-nombres-tablas-oficios',
  descripcion: 'Renombra las tablas de oficios a como las nombra el código (Linux distingue mayúsculas).',
  async check(db) {
    if (await lowerCaseTableNames(db) !== 0) return [];
    const problems = [];
    for (const name of TABLAS) {
      if (await tableExists(db, name.toLowerCase()) && await tableExists(db, name)) {
        problems.push(`existen ${name} y ${name.toLowerCase()}; hay que decidir a mano cuál conservar.`);
      }
    }
    return problems;
  },
  async up(db, { log }) {
    if (await lowerCaseTableNames(db) !== 0) return log('  El servidor no distingue mayúsculas en tablas; nada que renombrar.');
    const pending = await renames(db);
    if (!pending.length) return log('  Las tablas ya tienen el nombre correcto.');
    // One statement renames them all or none.
    await db.query(`RENAME TABLE ${pending.map(([from, to]) => `${quoteName(from)} TO ${quoteName(to)}`).join(', ')}`);
    log(`  Renombradas: ${pending.map(([, to]) => to).join(', ')}`);
  },
};
