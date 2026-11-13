import { columnExists, foreignKeyExists, quoteName, tableExists } from './helpers.js';

// objetivo and objetivoImei hold registrations (a Solución, its Seguimientos, the IMEI captures), not lines:
// the same line can appear many times. lineas is the line itself, one per number within a case, and both
// tables point to it, so a line's contacts and IMEI meet. Nothing is merged or deleted; a registration without
// a case or a number (the "sin utilidad" IMEI) has no line.
const TABLAS = ['objetivo', 'objetivoImei'];

// Kept here rather than imported, so the migration stays as it ran: digits only, the last ten, so a 52 prefix
// matches the national number; fewer than three digits is not a line.
const numeroDeLinea = (valor) => {
  const digits = String(valor ?? '').replace(/\D/g, '');
  return digits.length < 3 ? null : digits.slice(-10);
};

export default {
  id: '006-lineas',
  descripcion: 'Crea lineas (un número por caso) y enlaza con ella los registros de contactos e IMEI.',
  async check(db) {
    const problems = [];
    for (const table of TABLAS) if (!await tableExists(db, table)) problems.push(`no existe la tabla ${table}.`);
    return problems;
  },
  async up(db, { log }) {
    await db.query(`CREATE TABLE IF NOT EXISTS lineas (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      caso_id INT NOT NULL,
      numero VARCHAR(10) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY lineas_caso_numero (caso_id, numero),
      INDEX lineas_numero (numero),
      CONSTRAINT lineas_caso FOREIGN KEY (caso_id) REFERENCES casos (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    for (const table of TABLAS) {
      const t = quoteName(table);
      if (!await columnExists(db, table, 'linea_id')) {
        await db.query(`ALTER TABLE ${t} ADD COLUMN linea_id INT NULL AFTER caso_id, ADD INDEX ${quoteName(`${table}_linea_id`)} (linea_id)`);
      }
      const [rows] = await db.query(`SELECT idObjetivo AS id, CAST(numObjetivo AS CHAR) AS numero, caso_id AS casoId
        FROM ${t} WHERE linea_id IS NULL AND caso_id IS NOT NULL`);
      const porLinea = new Map();
      for (const { id, numero, casoId } of rows) {
        const linea = numeroDeLinea(numero);
        if (!linea) continue;
        const key = `${casoId}|${linea}`;
        if (!porLinea.has(key)) porLinea.set(key, { casoId, linea, ids: [] });
        porLinea.get(key).ids.push(id);
      }
      for (const { casoId, linea, ids } of porLinea.values()) {
        await db.query('INSERT IGNORE INTO lineas (caso_id, numero) VALUES (?, ?)', [casoId, linea]);
        await db.query(`UPDATE ${t} SET linea_id = (SELECT id FROM lineas WHERE caso_id = ? AND numero = ?) WHERE idObjetivo IN (?)`, [casoId, linea, ids]);
      }
      if (!await foreignKeyExists(db, table, `${table}_linea`)) {
        await db.query(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteName(`${table}_linea`)} FOREIGN KEY (linea_id) REFERENCES lineas (id)`);
      }
    }

    const [[{ lineas }]] = await db.query('SELECT COUNT(*) AS lineas FROM lineas');
    const [[{ ambas }]] = await db.query(`SELECT COUNT(*) AS ambas FROM lineas l
      WHERE EXISTS (SELECT 1 FROM objetivo o WHERE o.linea_id = l.id) AND EXISTS (SELECT 1 FROM objetivoImei i WHERE i.linea_id = l.id)`);
    const [[{ sinLinea }]] = await db.query('SELECT (SELECT COUNT(*) FROM objetivo WHERE linea_id IS NULL) + (SELECT COUNT(*) FROM objetivoImei WHERE linea_id IS NULL) AS sinLinea');
    log(`  ${lineas} líneas; ${ambas} con contactos e IMEI; registros sin línea (sin caso o sin número): ${sinLinea}.`);
  },
};
