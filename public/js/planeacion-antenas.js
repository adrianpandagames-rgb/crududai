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
