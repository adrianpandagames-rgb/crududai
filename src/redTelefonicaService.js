// Builds the objective/contact network used by /red-telefonica from the objetivo and contactos tables.
export const MAX_NETWORK_ROWS = 50000;

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

// Contacts are stored as typed in the call records, so a search tries the full digits and the 10-digit national number.
export const searchCandidates = (value) => {
  const digits = digitsOf(value);
  if (digits.length < 7 || digits.length > 15) return [];
  return [...new Set([digits, digits.slice(-10)])];
};

// Only lines that cross two objectives are kept, plus whatever the analyst searched for.
export function buildNetwork(rows, { totals = new Map(), focus = [] } = {}) {
  const objectives = new Map();
  const phones = new Map();
  const links = [];

  for (const row of rows) {
    const objectiveId = `objective:${row.idObjetivo}`;
    if (!objectives.has(objectiveId)) {
      objectives.set(objectiveId, {
        id: objectiveId, type: 'objective', label: String(row.numObjetivo), number: digitsOf(row.numObjetivo),
        nuc: row.nuc ?? '', tipo: row.tipo ?? '', ano: row.ano ?? '', delito: row.delito ?? '',
        totalContacts: Number(totals.get(row.idObjetivo) ?? 0),
      });
    }
    const number = digitsOf(row.contacto);
    // Rows such as "sin utilidad" carry no number to cross.
    if (number.length < 7) continue;
    const phoneId = `phone:${number}`;
    if (!phones.has(phoneId)) phones.set(phoneId, { id: phoneId, type: 'phone', label: number, number, objectives: new Set() });
    const phone = phones.get(phoneId);
    if (phone.objectives.has(objectiveId)) continue;
    phone.objectives.add(objectiveId);
    links.push({ id: `${objectiveId}|${phoneId}`, source: objectiveId, target: phoneId, kind: 'contacto' });
  }

  // A contact that is itself an objective's line joins both investigations directly.
  const objectivesByNumber = new Map();
  for (const objective of objectives.values()) {
    for (const key of [objective.number, objective.number.slice(-10)]) {
      if (!objectivesByNumber.has(key)) objectivesByNumber.set(key, []);
      objectivesByNumber.get(key).push(objective);
    }
  }
  for (const phone of phones.values()) {
    const owners = new Set([...(objectivesByNumber.get(phone.number) ?? []), ...(objectivesByNumber.get(phone.number.slice(-10)) ?? [])]);
    phone.ownerObjectives = [...owners].map((objective) => objective.id);
    for (const objective of owners) {
      links.push({ id: `${objective.id}=${phone.id}`, source: objective.id, target: phone.id, kind: 'linea' });
    }
  }

  const focusSet = new Set(focus);
  const isFocused = (number) => focusSet.has(number) || focusSet.has(number.slice(-10));
  const keptPhones = [...phones.values()].filter((phone) => phone.objectives.size > 1
    || phone.ownerObjectives.length > 0 || isFocused(phone.number));
  const keptPhoneIds = new Set(keptPhones.map((phone) => phone.id));
  const linkedObjectives = new Set(links.filter((link) => keptPhoneIds.has(link.target)).map((link) => link.source));
  const keptObjectives = [...objectives.values()].filter((objective) => linkedObjectives.has(objective.id) || isFocused(objective.number));
  const keptIds = new Set([...keptObjectives.map((objective) => objective.id), ...keptPhoneIds]);

  const phoneNodes = keptPhones.map(({ objectives: linked, ownerObjectives, ...phone }) => ({
    ...phone,
    crossings: linked.size,
    isObjectiveLine: ownerObjectives.length > 0,
    isFocus: isFocused(phone.number),
  }));
  const crossingCounts = new Map();
  for (const link of links) {
    if (link.kind === 'contacto' && phones.get(link.target).objectives.size > 1) {
      crossingCounts.set(link.source, (crossingCounts.get(link.source) ?? 0) + 1);
    }
  }
  const objectiveNodes = keptObjectives.map((objective) => ({
    ...objective,
    crossingContacts: crossingCounts.get(objective.id) ?? 0,
    isFocus: isFocused(objective.number),
  }));

  return {
    nodes: [...objectiveNodes, ...phoneNodes],
    links: links.filter((link) => keptIds.has(link.source) && keptIds.has(link.target)),
  };
}

const OBJECTIVE_COLUMNS = 'o.idObjetivo, o.numObjetivo, o.nuc, o.tipo, o.ano, o.delito';

const contactTotals = async (pool, objectiveIds) => {
  if (objectiveIds.length === 0) return new Map();
  const [rows] = await pool.query(
    'SELECT idObjetivo, COUNT(*) AS total FROM contactos WHERE idObjetivo IN (?) GROUP BY idObjetivo',
    [objectiveIds],
  );
  return new Map(rows.map((row) => [row.idObjetivo, row.total]));
};

const finish = async (pool, rows, options) => {
  const truncated = rows.length > MAX_NETWORK_ROWS;
  const kept = truncated ? rows.slice(0, MAX_NETWORK_ROWS) : rows;
  const totals = await contactTotals(pool, [...new Set(kept.map((row) => row.idObjetivo))]);
  return { ...buildNetwork(kept, { ...options, totals }), truncated };
};

// General view: the contacts shared between objectives. Every objective comes back so that
// an objective whose own line appears among another's contacts can still be drawn.
export async function fetchGeneralNetwork(pool) {
  const [rows] = await pool.query(`
    SELECT ${OBJECTIVE_COLUMNS}, c.contacto
    FROM objetivo o
    LEFT JOIN contactos c ON c.idObjetivo = o.idObjetivo AND (c.contacto IN (
      SELECT contacto FROM (
        SELECT contacto FROM contactos GROUP BY contacto HAVING COUNT(DISTINCT idObjetivo) > 1
      ) cruzados
    ) OR c.contacto IN (SELECT numObjetivo FROM objetivo))
    ORDER BY o.idObjetivo
    LIMIT ?`, [MAX_NETWORK_ROWS + 1]);
  return finish(pool, rows, {});
}

// Focused view: the objectives that own or contain the number, all of their contacts,
// and every other objective that shares one of those contacts or whose line appears among them.
export async function fetchFocusNetwork(pool, value) {
  const candidates = searchCandidates(value);
  if (candidates.length === 0) {
    const error = new Error('Ingresa un número de 7 a 15 dígitos.');
    error.status = 400;
    throw error;
  }
  const [seedRows] = await pool.query(`
    SELECT DISTINCT o.idObjetivo
    FROM objetivo o
    LEFT JOIN contactos c ON c.idObjetivo = o.idObjetivo
    WHERE o.numObjetivo IN (?) OR c.contacto IN (?)`, [candidates, candidates]);
  const seeds = seedRows.map((row) => row.idObjetivo);
  if (seeds.length === 0) return { nodes: [], links: [], truncated: false, found: false };

  const [rows] = await pool.query(`
    SELECT ${OBJECTIVE_COLUMNS}, c.contacto
    FROM contactos c
    INNER JOIN objetivo o ON o.idObjetivo = c.idObjetivo
    WHERE c.idObjetivo IN (?)
       OR c.contacto IN (SELECT contacto FROM contactos WHERE idObjetivo IN (?))
       OR c.contacto IN (SELECT numObjetivo FROM objetivo WHERE idObjetivo IN (?))
    UNION
    SELECT ${OBJECTIVE_COLUMNS}, NULL AS contacto
    FROM objetivo o
    WHERE o.numObjetivo IN (?)
       OR o.numObjetivo IN (SELECT contacto FROM contactos WHERE idObjetivo IN (?))
    LIMIT ?`, [seeds, seeds, seeds, candidates, seeds, MAX_NETWORK_ROWS + 1]);
  return { ...(await finish(pool, rows, { focus: candidates })), found: true };
}
