export function antennaClipboardText(group, totalRecords) {
  const percentage = totalRecords > 0 ? group.rows.length / totalRecords * 100 : 0;
  return [group.coordinates, group.rows.length, `${percentage.toFixed(2)}%`, group.ubicacion, group.lugar]
    .map((value) => String(value ?? '').replace(/[\t\r\n]+/g, ' '))
    .join('\t');
}

export function summarizeAntennas(data) {
  const headers = data.headers.map((value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
  const column = (pattern) => headers.findIndex((header) => pattern.test(header));
  const antenna = column(/antena|antenna/);
  const location = column(/ubicacion|location/);
  const place = column(/lugar|place/);
  const points = new Map(data.points.map((point) => [point.row, point]));
  const groups = new Map();
  data.rows.forEach((row, index) => {
    const name = String(row[antenna] ?? '').trim() || 'Sin antena';
    const ubicacion = String(row[location] ?? '').trim();
    const lugar = String(row[place] ?? '').trim();
    const point = points.get(index + 1);
    const coordinates = point ? `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}` : 'Sin coordenadas válidas';
    const key = JSON.stringify([name, ubicacion, lugar, coordinates]);
    if (!groups.has(key)) groups.set(key, { name, ubicacion, lugar, coordinates, rows: [], points: [] });
    const group = groups.get(key);
    group.rows.push(index + 1);
    if (point) group.points.push(point);
  });
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
}

const foldText = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Case- and accent-insensitive search over every cell of a record.
export function rowMatches(row, term) {
  const needle = foldText(term).trim();
  return !needle || row.some((cell) => foldText(cell).includes(needle));
}

// One light-to-dark red per fifth of the busiest site, so concentration reads at a glance. Red stands
// out on the beige OpenStreetMap base and even the lightest step keeps 2:1 contrast against it
// (the earlier light blues sat at 1.5:1 and got lost).
export const FREQUENCY_COLORS = ['#f08a7e', '#e8604f', '#d43d2f', '#a82820', '#6e140f'];

export function frequencyScale(maxCount) {
  const max = Math.max(Math.floor(maxCount) || 1, 1);
  const steps = Math.min(FREQUENCY_COLORS.length, max);
  const colors = FREQUENCY_COLORS.slice(FREQUENCY_COLORS.length - steps);
  const upper = colors.map((_, index) => Math.ceil((max * (index + 1)) / steps));
  const legend = colors.map((color, index) => {
    const from = index === 0 ? 1 : upper[index - 1] + 1;
    return { color, label: from >= upper[index] ? `${upper[index]}` : `${from}–${upper[index]}` };
  });
  return {
    legend,
    colorFor: (count) => colors[Math.max(upper.findIndex((limit) => count <= limit), 0)],
  };
}

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

// `rowNumbers` are 1-based, as in the table. The BOM keeps accents readable in Excel.
export function selectionCsv(headers, rows, rowNumbers) {
  const lines = [headers, ...[...rowNumbers].sort((a, b) => a - b).map((row) => rows[row - 1] || [])];
  return `﻿${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
