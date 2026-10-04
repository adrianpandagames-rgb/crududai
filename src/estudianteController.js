import pool from "./db.js";

const formatCoordinateValue = (value) => {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return String(value).trim();
  }

  return String(numericValue).replace(/(\.\d*?)0+$/, "$1").replace(/\.0+$/, "");
};

const normalizeLocationText = (value) => {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  const text = String(value).trim();
  return text === '' || text.endsWith('.') ? text : `${text}.`;
};

const parseCoordinateValue = (value) => {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return null;
  }

  const numericValue = Number(normalizedValue);
  if (!Number.isNaN(numericValue)) {
    return numericValue;
  }

  const dmsMatch = normalizedValue.match(/^(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([NSEW])$/i);
  if (!dmsMatch) {
    return null;
  }

  let decimalValue = Number(dmsMatch[1]) + Number(dmsMatch[2]) / 60 + Number(dmsMatch[3]) / 3600;
  const hemisphere = dmsMatch[4].toUpperCase();
  if (hemisphere === "S" || hemisphere === "W") {
    decimalValue = -decimalValue;
  }

  return decimalValue;
};

export const parseCoordinatesInput = (rawValue) => {
  const parts = String(rawValue || "").trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }

  const latitude = parseCoordinateValue(parts[0]);
  const longitude = parseCoordinateValue(parts[1]);

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
};

// Agregar un nuevo estudiante
export const agregarEstudiante = async ({
  nombre_alumno,
  email_alumno,
  curso_alumno,
}) => {
  try {
    await pool.query(
      "INSERT INTO estudiantes (nombre_alumno, email_alumno, curso_alumno, created_at) VALUES (?, ?, ?, ?)",
      [nombre_alumno, email_alumno, curso_alumno, new Date()]
    );
  } catch (error) {
    throw { status: 500, message: "Error al crear el estudiante" };
  }
};

// Obtener o crear objetivo y retornar idObjetivo y tipo real
export const obtenerOCrearObjetivo = async (numObjetivo, nuc, tipo, ano) => {
  try {
    const normalizedTipo = String(tipo || "").trim();
    const isSolucion = normalizedTipo.toLowerCase() === "solución" || normalizedTipo.toLowerCase() === "solucion";

    let tipoToInsert = normalizedTipo;

    if (isSolucion) {
      const [existingSolucion] = await pool.query(
        "SELECT idObjetivo FROM objetivo WHERE numObjetivo = ? AND nuc = ? AND tipo IN ('Solución', 'solución') AND ano = ?",
        [numObjetivo, nuc, ano]
      );

      if (existingSolucion.length > 0) {
        tipoToInsert = "Seguimiento";
      }
    }

    const [result] = await pool.query(
      "INSERT INTO objetivo (numObjetivo, nuc, tipo, ano) VALUES (?, ?, ?, ?)",
      [numObjetivo, nuc, tipoToInsert, ano]
    );

    return { idObjetivo: result.insertId, tipo: tipoToInsert };
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener o crear objetivo" };
  }
};

export const obtenerOCrearObjetivoImei = async (numObjetivo, nuc, tipo, ano) => {
  try {
    const normalizedTipo = String(tipo || "").trim();

    const [existingObjetivo] = await pool.query(
      "SELECT idObjetivo, tipo FROM objetivoImei WHERE numObjetivo = ? AND nuc = ? AND tipo = ? AND ano = ? LIMIT 1",
      [numObjetivo, nuc, normalizedTipo, ano]
    );

    if (existingObjetivo.length > 0) {
      return { idObjetivo: existingObjetivo[0].idObjetivo, tipo: existingObjetivo[0].tipo };
    }

    const [result] = await pool.query(
      "INSERT INTO objetivoImei (numObjetivo, nuc, tipo, ano) VALUES (?, ?, ?, ?)",
      [numObjetivo, nuc, normalizedTipo, ano]
    );

    return { idObjetivo: result.insertId, tipo: normalizedTipo };
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener o crear objetivo IMEI" };
  }
};

// Agregar contacto
export const registrarLineaSinUtilidad = async (numObjetivo, nuc, tipo, ano) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      'INSERT INTO objetivo (numObjetivo, nuc, tipo, ano) VALUES (?, ?, ?, ?)',
      [numObjetivo, nuc, tipo, ano]
    );
    await connection.query(
      'INSERT INTO contactos (contacto, idObjetivo) VALUES (?, ?)',
      ['sin utilidad', result.insertId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

export const agregarContacto = async (contacto, idObjetivo) => {
  try {
    await pool.query(
      "INSERT INTO contactos (contacto, idObjetivo) VALUES (?, ?)",
      [contacto, idObjetivo]
    );
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al agregar contacto" };
  }
};

// Agregar IMEI
export const agregarImei = async (imei, idObjetivo, metadata = {}) => {
  try {
    const brandName = metadata.brand_name || null;
    const modelo = metadata.modelo || null;
    await pool.query(
      "INSERT INTO imei (imei, idObjetivo, brand_name, modelo) VALUES (?, ?, ?, ?)",
      [imei, idObjetivo, brandName, modelo]
    );
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al agregar IMEI" };
  }
};

// Verificar si el IMEI ya existe para el mismo objetivo, nuc, tipo y año
export const imeiExisteExacto = async (imei, numObjetivo, nuc, tipo, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT 1 FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo WHERE i.imei = ? AND o.numObjetivo = ? AND o.nuc = ? AND o.tipo = ? AND o.ano = ? LIMIT 1",
      [imei, numObjetivo, nuc, tipo, ano]
    );
    return rows.length > 0;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al verificar IMEI existente" };
  }
};

// Buscar coincidencias parciales del mismo IMEI con diferente objetivo, nuc, tipo o año
export const imeiCoincidenciasParciales = async (imei, numObjetivo, nuc, tipo, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT o.numObjetivo, o.nuc, o.tipo, o.ano FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo WHERE i.imei = ? AND NOT (o.numObjetivo = ? AND o.nuc = ? AND o.tipo = ? AND o.ano = ?)",
      [imei, numObjetivo, nuc, tipo, ano]
    );
    return rows.map((row) => ({ ...row, issue: 'IMEI en otro objetivo' }));
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al verificar coincidencias parciales de IMEI" };
  }
};

export const imeiCoincidenciasPorObjetivo = async (numObjetivo, nuc, ano, imei) => {
  try {
    const [rows] = await pool.query(
      "SELECT i.imei, o.numObjetivo, o.nuc, o.tipo, o.ano FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo WHERE o.numObjetivo = ? AND o.nuc = ? AND o.ano = ? AND i.imei != ?",
      [numObjetivo, nuc, ano, imei]
    );
    return rows.map((row) => ({ ...row, issue: 'Objetivo en otro IMEI' }));
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al verificar coincidencias de objetivo IMEI" };
  }
};

export const buscarObjetivoEnObjetivoImei = async (numObjetivo, nuc = '', ano = '') => {
  try {
    const params = [numObjetivo];
    let sql = "SELECT o.numObjetivo, o.nuc, o.tipo, o.ano, i.imei FROM objetivoImei o LEFT JOIN imei i ON i.idObjetivo = o.idObjetivo WHERE o.numObjetivo = ?";

    if (nuc) {
      sql += " AND o.nuc = ?";
      params.push(nuc);
    }
    if (ano) {
      sql += " AND o.ano = ?";
      params.push(ano);
    }

    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al buscar objetivo en objetivo IMEI" };
  }
};

export const buscarObjetivoEnObjetivo = async (numObjetivo, nuc, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT numObjetivo, nuc, tipo, ano FROM objetivo WHERE numObjetivo = ? AND nuc = ? AND ano = ?",
      [numObjetivo, nuc, ano]
    );
    return rows;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al buscar objetivo en tabla objetivo" };
  }
};

// Obtener todos los IMEIs o buscar por término con paginación
export const listarImeis = async (searchTerm = "", page = 1, pageSize = 10) => {
  try {
    const offset = (page - 1) * pageSize;
    const hasSearch = searchTerm && searchTerm.toString().trim() !== "";

    if (hasSearch) {
      const term = `%${searchTerm.toString().trim()}%`;
      const [rows] = await pool.query(
        "SELECT i.idImei, i.idObjetivo, i.imei, o.numObjetivo, o.nuc, o.tipo, o.ano, i.brand_name, i.modelo FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo WHERE CONCAT_WS('|', i.imei, o.numObjetivo, o.nuc, o.tipo, o.ano, i.brand_name, i.modelo) LIKE ? LIMIT ? OFFSET ?",
        [term, pageSize, offset]
      );
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo WHERE CONCAT_WS('|', i.imei, o.numObjetivo, o.nuc, o.tipo, o.ano, i.brand_name, i.modelo) LIKE ?",
        [term]
      );
      return { rows, total: countRows[0].count };
    }

    const [rows] = await pool.query(
      'SELECT i.idImei, i.idObjetivo, i.imei, o.numObjetivo, o.nuc, o.tipo, o.ano, i.brand_name, i.modelo FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo LIMIT ? OFFSET ?',
      [pageSize, offset]
    );
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM imei i INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo'
    );
    return { rows, total: countRows[0].count };
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener IMEIs" };
  }
};

export const obtenerObjetivoPorId = async (idObjetivo) => {
  const [rows] = await pool.query(
    `SELECT o.idObjetivo, o.numObjetivo, o.nuc, o.tipo, o.ano,
            GROUP_CONCAT(c.contacto ORDER BY c.contacto SEPARATOR ', ') AS contactos
     FROM objetivo o
     LEFT JOIN contactos c ON c.idObjetivo = o.idObjetivo
     WHERE o.idObjetivo = ?
     GROUP BY o.idObjetivo`,
    [idObjetivo],
  );
  return rows[0] || null;
};

export const actualizarObjetivo = async (idObjetivo, { numObjetivo, nuc, tipo, ano }) => {
  const [existingRows] = await pool.query('SELECT idObjetivo FROM objetivo WHERE idObjetivo = ?', [idObjetivo]);
  if (existingRows.length !== 1) return false;
  const [result] = await pool.execute(
    'UPDATE objetivo SET numObjetivo = ?, nuc = ?, tipo = ?, ano = ? WHERE idObjetivo = ?',
    [numObjetivo, nuc, tipo, ano, idObjetivo],
  );
  return result.affectedRows >= 0;
};

export const obtenerImeiPorId = async (idImei) => {
  const [rows] = await pool.query(
    `SELECT i.idImei, i.idObjetivo, i.imei, i.brand_name, i.modelo,
            o.numObjetivo, o.nuc, o.tipo, o.ano
     FROM imei i
     INNER JOIN objetivoImei o ON i.idObjetivo = o.idObjetivo
     WHERE i.idImei = ?`,
    [idImei],
  );
  return rows[0] || null;
};

export const actualizarImei = async (idImei, { imei, numObjetivo, nuc, tipo, ano, brandName, modelo }) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute('SELECT idImei FROM imei WHERE idImei = ?', [idImei]);
    if (existingRows.length !== 1) {
      await connection.rollback();
      return false;
    }
    await connection.execute(
      'UPDATE imei SET imei = ?, brand_name = ?, modelo = ? WHERE idImei = ?',
      [imei, brandName || null, modelo || null, idImei],
    );
    await connection.execute(
      `UPDATE objetivoImei o
       INNER JOIN imei i ON i.idObjetivo = o.idObjetivo
       SET o.numObjetivo = ?, o.nuc = ?, o.tipo = ?, o.ano = ?
       WHERE i.idImei = ?`,
      [numObjetivo, nuc, tipo, ano, idImei],
    );
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Verificar si el contacto ya existe para el mismo objetivo, nuc, tipo y año
export const contactoExisteExacto = async (contacto, numObjetivo, nuc, tipo, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT 1 FROM contactos c INNER JOIN objetivo o ON c.idObjetivo = o.idObjetivo WHERE c.contacto = ? AND o.numObjetivo = ? AND o.nuc = ? AND o.tipo = ? AND o.ano = ? LIMIT 1",
      [contacto, numObjetivo, nuc, tipo, ano]
    );
    return rows.length > 0;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al verificar contacto existente" };
  }
};

// Buscar coincidencias parciales por el mismo contacto con diferente objetivo, nuc, tipo o año
export const contactoCoincidenciasParciales = async (contacto, numObjetivo, nuc, tipo, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT o.numObjetivo, o.nuc, o.tipo, o.ano FROM contactos c INNER JOIN objetivo o ON c.idObjetivo = o.idObjetivo WHERE c.contacto = ? AND NOT (o.numObjetivo = ? AND o.nuc = ? AND o.tipo = ? AND o.ano = ?)",
      [contacto, numObjetivo, nuc, tipo, ano]
    );
    return rows;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al verificar coincidencias parciales" };
  }
};

export const obtenerContactosPorObjetivo = async (numObjetivo, nuc, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT c.contacto FROM contactos c INNER JOIN objetivo o ON c.idObjetivo = o.idObjetivo WHERE o.numObjetivo = ? AND o.nuc = ? AND o.ano = ? ORDER BY c.contacto",
      [numObjetivo, nuc, ano]
    );
    return rows.map((row) => row.contacto);
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener contactos del objetivo" };
  }
};

export const obtenerContactosPorObjetivoId = async (idObjetivo) => {
  try {
    const [rows] = await pool.query(
      "SELECT contacto FROM contactos WHERE idObjetivo = ? ORDER BY contacto",
      [idObjetivo]
    );
    return rows.map((row) => row.contacto);
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener contactos por ID" };
  }
};

export const agregarUbicacion = async ({ latitude, longitude, ubicacion, lugar }) => {
  try {
    const normalizedLatitude = formatCoordinateValue(Number(latitude).toFixed(6));
    const normalizedLongitude = formatCoordinateValue(Number(longitude).toFixed(6));
    const normalizedUbicacion = normalizeLocationText(ubicacion);
    const normalizedLugar = normalizeLocationText(lugar);

    const [existingRows] = await pool.query(
      "SELECT idUbicacion FROM ubicaciones WHERE latitude = ? AND longitude = ? LIMIT 1",
      [normalizedLatitude, normalizedLongitude]
    );

    if (existingRows.length > 0) {
      throw { status: 409, message: "La coordenada ya se encuentra registrada." };
    }

    await pool.query(
      "INSERT INTO ubicaciones (latitude, longitude, ubicacion, lugar, created_at) VALUES (?, ?, ?, ?, ?)",
      [normalizedLatitude, normalizedLongitude, normalizedUbicacion, normalizedLugar, new Date()]
    );
  } catch (error) {
    console.log(error);
    if (error && error.status === 409) {
      throw error;
    }
    throw { status: 500, message: "Error al agregar ubicación" };
  }
};

export const listarUbicaciones = async (searchTerm = "", page = 1, pageSize = 10) => {
  try {
    const offset = (page - 1) * pageSize;
    const normalizedSearchTerm = searchTerm.toString().trim();
    const hasSearch = normalizedSearchTerm !== "";

    if (hasSearch) {
      const parsedCoordinates = parseCoordinatesInput(normalizedSearchTerm);

      if (parsedCoordinates) {
        const latitude = Number(parsedCoordinates.latitude.toFixed(6));
        const longitude = Number(parsedCoordinates.longitude.toFixed(6));

        const [rows] = await pool.query(
          'SELECT * FROM ubicaciones WHERE ABS(CAST(latitude AS DECIMAL(10,6)) - ?) < 0.000001 AND ABS(CAST(longitude AS DECIMAL(10,6)) - ?) < 0.000001 ORDER BY idUbicacion DESC LIMIT ? OFFSET ?',
          [latitude, longitude, pageSize, offset]
        );
        const [countRows] = await pool.query(
          'SELECT COUNT(*) AS count FROM ubicaciones WHERE ABS(CAST(latitude AS DECIMAL(10,6)) - ?) < 0.000001 AND ABS(CAST(longitude AS DECIMAL(10,6)) - ?) < 0.000001',
          [latitude, longitude]
        );
        return { rows, total: countRows[0].count };
      }

      const term = `%${normalizedSearchTerm}%`;
      const [rows] = await pool.query(
        "SELECT * FROM ubicaciones WHERE CONCAT_WS('|', latitude, longitude, ubicacion, lugar) LIKE ? ORDER BY idUbicacion DESC LIMIT ? OFFSET ?",
        [term, pageSize, offset]
      );
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM ubicaciones WHERE CONCAT_WS('|', latitude, longitude, ubicacion, lugar) LIKE ?",
        [term]
      );
      return { rows, total: countRows[0].count };
    }

    const [rows] = await pool.query(
      'SELECT * FROM ubicaciones ORDER BY idUbicacion DESC LIMIT ? OFFSET ?',
      [pageSize, offset]
    );
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM ubicaciones'
    );
    return { rows, total: countRows[0].count };
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener ubicaciones" };
  }
};

export const listarUbicacionesParaRuta = async () => {
  try {
    const [rows] = await pool.query(
      'SELECT idUbicacion, latitude, longitude, ubicacion, lugar FROM ubicaciones'
    );
    return rows;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener ubicaciones para Ruta" };
  }
};

export const buscarObjetivoConContactos = async (numObjetivo, nuc, ano) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT o.idObjetivo, o.numObjetivo, o.nuc, o.tipo, o.ano FROM objetivo o WHERE o.numObjetivo = ? AND o.nuc = ? AND o.ano = ?",
      [numObjetivo, nuc, ano]
    );
    return rows;
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al buscar objetivo con contactos" };
  }
};

export const verificarObjetivoConContactos = async (numObjetivo, nuc, ano, nuevosContactos) => {
  try {
    const existentes = await buscarObjetivoConContactos(numObjetivo, nuc, ano);
    if (existentes.length === 0) {
      return { existe: false, objetivos: [] };
    }

    const nuevosContactosSorted = nuevosContactos.sort();
    const resultados = [];

    for (const obj of existentes) {
      const contactosObj = await obtenerContactosPorObjetivoId(obj.idObjetivo);
      const contactosObjSorted = contactosObj.sort();
      const tienenMismos = nuevosContactosSorted.length === contactosObjSorted.length &&
                          nuevosContactosSorted.every((v, i) => v === contactosObjSorted[i]);
      resultados.push({
        idObjetivo: obj.idObjetivo,
        numObjetivo: obj.numObjetivo,
        nuc: obj.nuc,
        tipo: obj.tipo,
        ano: obj.ano,
        contactos: contactosObj,
        tienenMismos,
      });
    }

    const conMismos = resultados.find((r) => r.tienenMismos);
    return {
      existe: conMismos ? true : false,
      objetivos: resultados,
      conMismos: conMismos || null,
    };
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al verificar objetivo con contactos" };
  }
};

// Obtener todos los estudiantes o buscar por término con paginación
export const listarEstudiantes = async (searchTerm = "", page = 1, pageSize = 10) => {
  try {
    const offset = (page - 1) * pageSize;
    const normalizedSearchTerm = searchTerm.toString().trim();
    const hasSearch = normalizedSearchTerm !== "";

    if (hasSearch) {
      const colonTerms = normalizedSearchTerm.split(':').map((value) => value.trim()).filter(Boolean);
      if (colonTerms.length === 2) {
        const [termA, termB] = colonTerms;
        const [rows] = await pool.query(
          `SELECT objetivo.idObjetivo, objetivo.numObjetivo, contactos.contacto, objetivo.nuc, objetivo.tipo, objetivo.ano
           FROM objetivo
           INNER JOIN contactos ON objetivo.idObjetivo = contactos.idObjetivo
           WHERE (objetivo.numObjetivo = ? AND contactos.contacto LIKE ?)
              OR (objetivo.numObjetivo = ? AND contactos.contacto LIKE ?)
           LIMIT ? OFFSET ?`,
          [termA, `%${termB}%`, termB, `%${termA}%`, pageSize, offset]
        );
        const [countRows] = await pool.query(
          `SELECT COUNT(*) AS count
           FROM objetivo
           INNER JOIN contactos ON objetivo.idObjetivo = contactos.idObjetivo
           WHERE (objetivo.numObjetivo = ? AND contactos.contacto LIKE ?)
              OR (objetivo.numObjetivo = ? AND contactos.contacto LIKE ?)`,
          [termA, `%${termB}%`, termB, `%${termA}%`]
        );
        return { rows, total: countRows[0].count };
      }

      const term = `%${normalizedSearchTerm}%`;
      const [rows] = await pool.query(
        "SELECT objetivo.idObjetivo, objetivo.numObjetivo, contactos.contacto, objetivo.nuc, objetivo.tipo, objetivo.ano FROM objetivo INNER JOIN contactos ON objetivo.idObjetivo = contactos.idObjetivo WHERE CONCAT_WS('|', objetivo.numObjetivo, contactos.contacto, objetivo.nuc, objetivo.tipo, objetivo.ano) LIKE ? LIMIT ? OFFSET ?",
        [term, pageSize, offset]
      );
      const [countRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM objetivo INNER JOIN contactos ON objetivo.idObjetivo = contactos.idObjetivo WHERE CONCAT_WS('|', objetivo.numObjetivo, contactos.contacto, objetivo.nuc, objetivo.tipo, objetivo.ano) LIKE ?",
        [term]
      );
      return { rows, total: countRows[0].count };
    }

    const [rows] = await pool.query(
      'SELECT objetivo.idObjetivo, objetivo.numObjetivo, contactos.contacto, objetivo.nuc, objetivo.tipo, objetivo.ano FROM objetivo INNER JOIN contactos ON objetivo.idObjetivo = contactos.idObjetivo LIMIT ? OFFSET ?',
      [pageSize, offset]
    );
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM objetivo INNER JOIN contactos ON objetivo.idObjetivo = contactos.idObjetivo'
    );
    return { rows, total: countRows[0].count };
  } catch (error) {
    console.log(error);
    throw { status: 500, message: "Error al obtener objetivo" };
  }
};
