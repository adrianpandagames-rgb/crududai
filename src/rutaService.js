import * as XLSX from 'xlsx';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';

const MAX_DATA_ROWS = 100000;

const parseDmsCoordinate = (value) => {
  const normalizedValue = String(value ?? '').trim().replace(/[º]/g, '°').replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  const dmsMatch = normalizedValue.match(/^(\d{1,3})\s*°\s*(\d{1,2})\s*'\s*(\d+(?:\.\d+)?)\s*"?\s*([NSEW])?$/i);
  if (!dmsMatch) return null;

  const degrees = Number(dmsMatch[1]);
  const minutes = Number(dmsMatch[2]);
  const seconds = Number(dmsMatch[3]);
  if (minutes >= 60 || seconds >= 60) return null;

  const coordinate = degrees + (minutes / 60) + (seconds / 3600);
  return /[SW]/i.test(dmsMatch[4] || '') ? -coordinate : coordinate;
};

export const parseCoordinateNumber = (value, delimiter = ',') => {
  const normalizedValue = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(delimiter === ';' ? ',' : /,(?=\d{3}(?:\D|$))/g, delimiter === ';' ? '.' : '');
  const parsedValue = Number(normalizedValue);
  const dmsValue = parseDmsCoordinate(value);
  if (Number.isFinite(parsedValue)) return parsedValue;
  if (dmsValue !== null) return dmsValue;
  return null;
};

export const normalizeRutaValue = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

export const detectCsvDelimiter = (text) => {
  const firstLine = String(text).split(/\r?\n/, 1)[0];
  const delimiters = [',', ';', '\t'];
  return delimiters.reduce((bestDelimiter, delimiter) => {
    const currentCount = firstLine.split(delimiter).length - 1;
    const bestCount = firstLine.split(bestDelimiter).length - 1;
    return currentCount > bestCount ? delimiter : bestDelimiter;
  }, ',');
};

export const parseCsv = (text, delimiter = detectCsvDelimiter(text)) => {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === delimiter && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && nextCharacter === '\n') index += 1;
      row.push(value);
      value = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      value += character;
    }

    if (rows.length > MAX_DATA_ROWS + 1) {
      throw new Error(`El archivo supera el límite de ${MAX_DATA_ROWS} filas.`);
    }
  }

  if (value !== '' || row.length > 0) {
    row.push(value);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }

  return rows;
};

const csvEscape = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const normalizeRutaTime = (value) => {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return value;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const meridiem = match[4]?.toUpperCase();
  if (minutes > 59 || seconds > 59) return value;
  if (meridiem) {
    if (hours < 1 || hours > 12) return value;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    if (meridiem === 'PM' && hours < 12) hours += 12;
  } else if (hours > 23) {
    return value;
  }

  return `${String(hours).padStart(2, '0')}:${match[2]}:${match[3]}`;
};

const normalizeRutaDateText = (value) => {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return text;

  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${year}`;
};

const excelSerialDateParts = (serial, date1904 = false) => {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.floor(serial) * 24 * 60 * 60 * 1000);
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
};

export const buildRutaLocationIndex = (locations) => {
  const index = new Map();

  const coordinateKey = (latitude, longitude) => {
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)) return '';
    return `${parsedLatitude.toFixed(6)},${parsedLongitude.toFixed(6)}`;
  };

  for (const location of locations) {
    const values = [
      location.idUbicacion,
      location.latitude,
      location.longitude,
      location.ubicacion,
      location.lugar,
      `${location.latitude},${location.longitude}`,
      `${location.latitude} ${location.longitude}`,
    ];

    const normalizedCoordinates = coordinateKey(location.latitude, location.longitude);
    if (normalizedCoordinates && !index.has(normalizedCoordinates)) {
      index.set(normalizedCoordinates, location);
    }

    for (const value of values) {
      const key = normalizeRutaValue(value);
      if (key && !index.has(key)) index.set(key, location);
    }
  }

  return index;
};

const processRutaRows = (rows, locations, delimiter = ',') => {
  if (rows.length > MAX_DATA_ROWS + 1) {
    throw new Error(`El archivo supera el límite de ${MAX_DATA_ROWS} filas.`);
  }
  if (rows.length === 0) throw new Error('El CSV está vacío.');

  const originalHeaders = rows[0].slice();
  const headers = originalHeaders.map(normalizeRutaValue);
  const findColumn = (names) => headers.findIndex((header) => names.some((name) => header === name));
  const findColumnContaining = (names) => headers.findIndex((header) => names.some((name) => header.includes(name)));
  const antennaColumn = findColumnContaining(['antena', 'antenna']);
  const latitudeColumn = findColumnContaining(['latitud', 'latitude', 'lat']);
  const longitudeColumn = findColumnContaining(['longitud', 'longitude', 'lon', 'long']);
  const locationColumn = findColumnContaining(['ubicacion', 'ubicación', 'location']);
  const placeColumn = findColumnContaining(['lugar', 'place']);

  const outputHeaders = originalHeaders.slice();
  const ensureColumn = (columnIndex, label) => {
    if (columnIndex >= 0) return columnIndex;
    outputHeaders.push(label);
    return outputHeaders.length - 1;
  };

  const outputAntennaColumn = ensureColumn(antennaColumn, 'antena');
  const outputLocationColumn = ensureColumn(locationColumn, 'ubicacion');
  const outputPlaceColumn = ensureColumn(placeColumn, 'lugar');
  const outputLatitudeColumn = ensureColumn(latitudeColumn, 'latitud');
  const outputLongitudeColumn = ensureColumn(longitudeColumn, 'longitud');
  const locationIndex = buildRutaLocationIndex(locations);
  const antennaNumbers = new Map();
  const result = [outputHeaders];
  let nextAntennaNumber = 1;

  for (const sourceRow of rows.slice(1)) {
    const outputRow = sourceRow.slice();
    while (outputRow.length < outputHeaders.length) outputRow.push('');

    const rawAntenna = String(antennaColumn >= 0 ? sourceRow[antennaColumn] ?? '' : '').trim();
    const rawLatitude = String(latitudeColumn >= 0 ? sourceRow[latitudeColumn] ?? '' : '').trim();
    const rawLongitude = String(longitudeColumn >= 0 ? sourceRow[longitudeColumn] ?? '' : '').trim();
    const numericLatitude = parseCoordinateNumber(rawLatitude, delimiter);
    const numericLongitude = parseCoordinateNumber(rawLongitude, delimiter);
    const coordinateKey = numericLatitude !== null && numericLongitude !== null
      ? `${numericLatitude.toFixed(6)},${numericLongitude.toFixed(6)}`
      : '';
    const sourceKey = coordinateKey || rawAntenna;
    if (!sourceKey) {
      result.push(outputRow);
      continue;
    }

    const antennaKey = normalizeRutaValue(sourceKey);
    if (!antennaNumbers.has(antennaKey)) antennaNumbers.set(antennaKey, nextAntennaNumber++);

    const location = locationIndex.get(coordinateKey) || locationIndex.get(normalizeRutaValue(rawAntenna));
    outputRow[outputAntennaColumn] = antennaNumbers.get(antennaKey);
    outputRow[outputLocationColumn] = location?.ubicacion ?? '';
    outputRow[outputPlaceColumn] = location?.lugar ?? '';
    if (!rawLatitude && location) outputRow[outputLatitudeColumn] = location.latitude ?? '';
    if (!rawLongitude && location) outputRow[outputLongitudeColumn] = location.longitude ?? '';
    result.push(outputRow);
  }

  result.delimiter = delimiter;
  return result;
};

export const processRutaCsv = (text, locations) => {
  const normalizedText = text.replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(normalizedText);
  return processRutaRows(parseCsv(normalizedText, delimiter), locations, delimiter);
};

export const readRutaXlsxRows = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('El archivo Excel no contiene hojas.');

  const worksheet = workbook.Sheets[firstSheetName];
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;

  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  });

  const dateColumns = (rows[0] || []).reduce((columns, header, index) => {
    if (/^(fecha|date)$/i.test(String(header).trim())) columns.push(index);
    return columns;
  }, []);
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    for (const columnIndex of dateColumns) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[cellAddress];
      if (!cell) continue;
      if (cell.t === 'n' && Number.isFinite(cell.v)) {
        const dateParts = excelSerialDateParts(cell.v, date1904);
        if (dateParts) {
          rows[rowIndex][columnIndex] = [dateParts.day, dateParts.month, dateParts.year]
            .map((part) => String(part).padStart(2, '0'))
            .join('/');
        }
      } else if (typeof cell.w === 'string' && cell.w.trim()) {
        rows[rowIndex][columnIndex] = cell.w;
      }
    }
  }

  return rows.map((row) => row.map(normalizeRutaTime));
};

export const processRutaXlsx = (buffer, locations) => processRutaRows(readRutaXlsxRows(buffer), locations);

export const getRutaXlsxMetadata = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer', bookProps: true, bookFiles: false });
  return workbook.Props || {};
};

export const createRutaCsv = (rows, delimiter = rows.delimiter || ',') => rows
  .map((row) => row.map(csvEscape).join(delimiter))
  .join('\r\n') + '\r\n';

const extractRouteHeatmapPointsFromRows = (rows) => {
  if (!Array.isArray(rows) || rows.length < 2) return [];

  const headers = rows[0].map((header) => normalizeRutaValue(String(header ?? '')));
  const latitudeIndex = headers.findIndex((header) => /^(latitud|latitude|lat)$/i.test(header));
  const longitudeIndex = headers.findIndex((header) => /^(longitud|longitude|lon|long)$/i.test(header));
  if (latitudeIndex === -1 || longitudeIndex === -1) return [];

  const pointsByKey = new Map();

  for (const row of rows.slice(1)) {
    const rawLatitude = row[latitudeIndex] ?? '';
    const rawLongitude = row[longitudeIndex] ?? '';
    const delimiter = ',';
    const latitude = parseCoordinateNumber(rawLatitude, delimiter);
    const longitude = parseCoordinateNumber(rawLongitude, delimiter);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;

    const key = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    const current = pointsByKey.get(key) || { lat: latitude, lng: longitude, weight: 0 };
    current.weight += 1;
    pointsByKey.set(key, current);
  }

  return [...pointsByKey.values()].sort((left, right) => right.weight - left.weight || left.lat - right.lat || left.lng - right.lng);
};

export const extractRutaHeatmapPoints = (csvText) => {
  const normalizedText = String(csvText || '').replace(/^\uFEFF/, '');
  if (!normalizedText.trim()) return [];

  const delimiter = detectCsvDelimiter(normalizedText);
  const rows = parseCsv(normalizedText, delimiter);
  return extractRouteHeatmapPointsFromRows(rows.map((row) => row.map((cell) => String(cell ?? ''))));
};

export const generateRutaHeatmapImageFromSource = async (buffer, extension, options = {}) => {
  const normalizedExtension = String(extension || '').toLowerCase();

  if (normalizedExtension === '.xlsx') {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet) return null;
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false,
    });
    return generateRutaHeatmapImageFromCsv(
      rows.length > 0 ? rows.map((row) => row.join(',')).join('\n') : '',
      options,
      extractRouteHeatmapPointsFromRows(rows),
    );
  }

  return generateRutaHeatmapImageFromCsv(buffer.toString('utf8'), options, extractRutaHeatmapPoints(buffer.toString('utf8')));
};

const escapeXml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;');

export const generateRutaHeatmapImageFromCsv = async (csvText, options = {}, explicitPoints = null) => {
  const width = Number(options.width) || 1200;
  const height = Number(options.height) || 760;
  const margin = 56;
  const points = explicitPoints ?? extractRutaHeatmapPoints(csvText);

  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    `<filter id="softBlur" x="-50%" y="-50%" width="200%" height="200%">`,
    `<feGaussianBlur stdDeviation="12"/>`,
    `</filter>`,
    `<radialGradient id="heatGradient" cx="50%" cy="50%" r="50%">`,
    `<stop offset="0%" stop-color="#ffd166" stop-opacity="0.96"/>`,
    `<stop offset="38%" stop-color="#ff7f50" stop-opacity="0.8"/>`,
    `<stop offset="100%" stop-color="#ef476f" stop-opacity="0"/>`,
    `</radialGradient>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="#edf3fa"/>`,
    `<rect x="${margin / 2}" y="${margin / 2}" width="${width - margin}" height="${height - margin}" rx="18" fill="#f8fbff" stroke="#d7e3f1" stroke-width="2"/>`,
  ];

  if (points.length === 0) {
    svgParts.push(
      `<text x="50%" y="50%" text-anchor="middle" fill="#5a6878" font-size="28" font-family="Arial, Helvetica, sans-serif">Sin coordenadas válidas en el archivo</text>`,
      `</svg>`
    );
    return sharp(Buffer.from(svgParts.join(''))).png().toBuffer();
  }

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  }

  const latSpan = (maxLat - minLat) || 0.01;
  const lngSpan = (maxLng - minLng) || 0.01;
  const padLat = latSpan * 0.12;
  const padLng = lngSpan * 0.12;
  const mapMinLat = minLat - padLat;
  const mapMaxLat = maxLat + padLat;
  const mapMinLng = minLng - padLng;
  const mapMaxLng = maxLng + padLng;

  const radialBlobs = points.map((point) => {
    const normalizedX = (point.lng - mapMinLng) / (mapMaxLng - mapMinLng || 1);
    const normalizedY = (mapMaxLat - point.lat) / (mapMaxLat - mapMinLat || 1);
    const x = margin + normalizedX * (width - margin * 2);
    const y = margin + normalizedY * (height - margin * 2);
    const radius = 18 + Math.min(point.weight * 18, 52);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="url(#heatGradient)" opacity="0.9" filter="url(#softBlur)"/>`;
  }).join('');

  const pointsMarkup = points.map((point) => {
    const normalizedX = (point.lng - mapMinLng) / (mapMaxLng - mapMinLng || 1);
    const normalizedY = (mapMaxLat - point.lat) / (mapMaxLat - mapMinLat || 1);
    const x = margin + normalizedX * (width - margin * 2);
    const y = margin + normalizedY * (height - margin * 2);
    const radius = 4 + Math.min(point.weight * 3, 12);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="#ef476f" opacity="0.9"/>`;
  }).join('');

  svgParts.push(
    `<g>${radialBlobs}</g>`,
    `<g>${pointsMarkup}</g>`,
    `<text x="${margin}" y="${height - 18}" fill="#607089" font-size="18" font-family="Arial, Helvetica, sans-serif">${escapeXml(`${minLat.toFixed(4)}, ${minLng.toFixed(4)}`)} • ${escapeXml(`${maxLat.toFixed(4)}, ${maxLng.toFixed(4)}`)}</text>`,
    `</svg>`,
  );

  return sharp(Buffer.from(svgParts.join(''))).png().toBuffer();
};

export const createRutaPdf = async (csvText, lineNumber, heatmapImageBuffer = null) => {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];

  return new Promise(async (resolve, reject) => {
    try {
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(`Geoposicionamiento - Línea ${lineNumber || 'N/A'}`, { align: 'center' });
      doc.moveDown(0.5);

      const points = extractRutaHeatmapPoints(csvText);
      doc.fontSize(12).text(`Puntos de coordenadas del archivo: ${points.length}`);
      doc.moveDown(0.75);

      let imageBuffer = heatmapImageBuffer || null;
      if (!imageBuffer) {
        imageBuffer = await generateRutaHeatmapImageFromCsv(csvText, { width: 500, height: 280 }).catch(() => null);
      }

      if (imageBuffer) {
        doc.image(imageBuffer, { fit: [500, 280], align: 'center', valign: 'center' });
        doc.moveDown(0.75);
      } else {
        doc.text('No se detectaron coordenadas válidas para generar el mapa de calor.', { align: 'center' });
      }

      if (points.length > 0) {
        doc.fontSize(11).text('Coordenadas detectadas:', { underline: true });
        points.slice(0, 10).forEach((point) => {
          doc.text(`• ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)} · peso ${point.weight}`);
        });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

export const createRutaXlsx = (csvText, sourceMetadata = {}) => {
  const normalizedText = String(csvText || '').replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(normalizedText);
  const rows = parseCsv(normalizedText, delimiter);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const dateColumns = (rows[0] || []).reduce((columns, header, index) => {
    if (/^(fecha|date)$/i.test(String(header).trim())) columns.push(index);
    return columns;
  }, []);
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    for (const columnIndex of dateColumns) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[cellAddress];
      if (!cell) continue;
      cell.t = 's';
      cell.v = normalizeRutaDateText(cell.v);
      cell.z = '@';
    }
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Ruta');
  if (sourceMetadata && Object.keys(sourceMetadata).length > 0) {
    workbook.Props = { ...sourceMetadata };
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};
