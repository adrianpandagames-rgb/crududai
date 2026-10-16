// Pure parser: importing it never opens a database connection.
export function parseSearchCoordinates(input) {
  const decimal = '[+-]?\\d+(?:\\.\\d+)?';
  const dms = '\\d{1,3}\\s*[°º]\\s*\\d{1,2}\\s*[\u0027’′]\\s*\\d{1,2}(?:\\.\\d+)?\\s*[\u0022”″]?\\s*[NSEWO]';
  const token = `(?:${dms}|${decimal})`;
  const pair = String(input).trim().match(new RegExp(`^(${token})[\\s,;]+(${token})$`, 'i'));
  if (!pair) {
    if (/[°º]/.test(input) || (/^[+-]?\d/.test(input) && /[,;]/.test(input))) {
      throw new Error('Coordenadas inválidas. Usa decimal o DMS: 29°4\u002719.2\u0022N, 110°57\u002721.6\u0022W.');
    }
    return null;
  }
  function convert(value, axis) {
    const match = value.match(/^(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:\.\d+)?)\s*["”″]?\s*([NSEWO])$/i);
    let result;
    if (match) {
      const [, degrees, minutes, seconds, direction] = match;
      const hemisphere = direction.toUpperCase();
      if (Number(minutes) >= 60 || Number(seconds) >= 60 || !(axis === 'lat' ? 'NS' : 'EWO').includes(hemisphere)) {
        throw new Error('DMS inválido: verifica minutos, segundos y hemisferio.');
      }
      result = Number(degrees) + Number(minutes) / 60 + Number(seconds) / 3600;
      if ('SWO'.includes(hemisphere)) result = -result;
    } else {
      result = Number(value);
    }
    if (!Number.isFinite(result) || Math.abs(result) > (axis === 'lat' ? 90 : 180)) {
      throw new Error('Coordenadas fuera de rango.');
    }
    return result;
  }
  return { latitude: convert(pair[1], 'lat'), longitude: convert(pair[2], 'lng') };
}
