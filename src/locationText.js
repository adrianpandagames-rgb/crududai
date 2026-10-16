export function capitalizeLocationWords(value) {
  return String(value ?? '').toLocaleLowerCase('es-MX')
    .replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toLocaleUpperCase('es-MX'));
}

export function normalizeStoredCity(value) {
  if (value == null) return value;
  const text = String(value);
  const separator = text.lastIndexOf(',');
  const city = separator === -1 ? text : text.slice(0, separator);
  const state = separator === -1 ? '' : text.slice(separator);
  return capitalizeLocationWords(removeParentheticalText(city)) + state;
}

export function removeParentheticalText(value) {
  let depth = 0;
  let result = '';
  for (const character of String(value ?? '')) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      result += character;
    }
  }
  return result.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}
