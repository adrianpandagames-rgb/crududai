import * as XLSX from 'xlsx';

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

const parseCoordinateNumber = (value, delimiter = ',') => {
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

export const processRutaXlsx = (buffer, locations) => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('El archivo Excel no contiene hojas.');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  });
  return processRutaRows(rows, locations);
};

export const createRutaCsv = (rows, delimiter = rows.delimiter || ',') => rows
  .map((row) => row.map(csvEscape).join(delimiter))
  .join('\r\n') + '\r\n';
