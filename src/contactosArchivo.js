import { findContactColumns, lineKey } from '../public/js/planeacion-contactos.js';

// A carrier's file as delivered: the table may start below the holder's data (Telcel puts "Linea:", "Nombre:"…
// first), so the header is the first row with both a Número A and a Número B column.
const findTable = (rows) => {
  for (let index = 0; index < rows.length; index++) {
    const { a, b } = findContactColumns(rows[index] || []);
    if (a >= 0 && b >= 0) return { headerIndex: index, a, b };
  }
  return null;
};

// The contacts of the typed line, one per record as a "contactos" column would list them: in each row the
// number on the other side (A or B) from the target. Rows without a number there (data sessions, "ims") are skipped.
// Every sheet is read: Movistar splits one sábana over several sheets, and a sheet without its own header continues
// the previous sheet's columns.
// When the typed line is not in the file, `sugerencia` is the number present in most rows, to point out a typo.
export function contactosPorNumeros(sheets, numObjetivo) {
  const target = lineKey(numObjetivo);
  if (!target) return { contactos: [], error: 'Escribe la línea objetivo para buscar sus contactos en el archivo.' };
  const contactos = [];
  const counts = new Map();
  let previous = null;
  for (const rows of sheets) {
    const table = findTable(rows) || (previous && { ...previous, headerIndex: -1 });
    if (!table) continue;
    previous = table;
    for (const row of rows.slice(table.headerIndex + 1)) {
      const keyA = lineKey(row[table.a]);
      const keyB = lineKey(row[table.b]);
      for (const key of new Set([keyA, keyB])) if (key) counts.set(key, (counts.get(key) || 0) + 1);
      if (keyA === target && keyB && keyB !== target) contactos.push(keyB);
      else if (keyB === target && keyA && keyA !== target) contactos.push(keyA);
    }
  }
  if (contactos.length) return { contactos };
  if (!previous) return { contactos: [], error: 'El archivo no trae la columna contactos ni las columnas Número A y Número B.' };
  let sugerencia = '';
  let sugerenciaTotal = 0;
  for (const [key, count] of counts) {
    if (count > sugerenciaTotal) [sugerencia, sugerenciaTotal] = [key, count];
  }
  return {
    contactos: [],
    error: `La línea ${String(numObjetivo).trim()} no aparece en las columnas Número A o Número B del archivo.`
      + (sugerencia && sugerencia !== target ? ` La que más se repite es ${sugerencia}; revisa que la línea objetivo esté bien escrita.` : ''),
  };
}
