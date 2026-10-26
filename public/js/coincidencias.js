const byId = (id) => document.getElementById(id);
// Module scripts have no document.currentScript, so the limit is read from the tag itself.
const MAX_FILES = Number(document.querySelector('script[data-max-files]')?.dataset.maxFiles) || 20;
const PAGE_SIZE = 200;
const status = byId('matchesStatus');
const form = byId('matchesForm');
const input = byId('matchesFiles');
const zone = byId('matchesDropZone');
const submit = byId('matchesSubmit');
const minutes = byId('matchesMinutes');
const metres = byId('matchesMetres');
// Each entry: { file, line }. Files are kept only in this page.
let selected = [];

function message(text, error = false) {
  status.textContent = text;
  status.className = 'alert ' + (error ? 'alert-danger' : 'alert-info');
}

// Same rule as the server: a 10–15 digit run in the name, otherwise the name itself.
function lineFromFileName(name) {
  const base = String(name).replace(/\.[^.]+$/, '').trim();
  const digits = base.match(/(?<!\d)\d{10,15}(?!\d)/) || base.replace(/[\s()-]/g, '').match(/\d{10,15}/);
  return (digits ? digits[0] : base).slice(0, 50);
}

function renderFiles() {
  const rows = selected.map((entry, index) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = entry.file.name;
    const lineCell = document.createElement('td');
    const line = document.createElement('input');
    line.className = 'form-control form-control-sm';
    line.maxLength = 50;
    line.required = true;
    line.value = entry.line;
    line.setAttribute('aria-label', `Línea de ${entry.file.name}`);
    line.addEventListener('input', () => { entry.line = line.value; });
    lineCell.append(line);
    const removeCell = document.createElement('td');
    removeCell.className = 'text-end';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-sm btn-outline-danger';
    remove.textContent = 'Quitar';
    remove.setAttribute('aria-label', `Quitar ${entry.file.name}`);
    remove.addEventListener('click', () => {
      selected.splice(index, 1);
      renderFiles();
    });
    removeCell.append(remove);
    row.append(name, lineCell, removeCell);
    return row;
  });
  byId('matchesFileRows').replaceChildren(...rows);
  byId('matchesFileList').hidden = !selected.length;
  submit.disabled = selected.length < 2;
  const lines = new Set(selected.map((entry) => entry.line.trim())).size;
  if (selected.length < 2) message(selected.length ? 'Agrega al menos un archivo más para comparar.' : 'Agrega al menos dos archivos para buscar coincidencias.');
  else message(`${selected.length} archivos listos de ${lines} ${lines === 1 ? 'línea' : 'líneas'}; los de la misma línea se juntan. Revisa la línea de cada uno y pulsa “Buscar coincidencias”.`);
}

function addFiles(files) {
  const skipped = [];
  for (const file of files) {
    if (!/\.(csv|xlsx)$/i.test(file.name)) { skipped.push(`${file.name} no es CSV ni Excel (.xlsx)`); continue; }
    if (selected.some((entry) => entry.file.name === file.name && entry.file.size === file.size)) continue;
    if (selected.length >= MAX_FILES) { skipped.push(`solo se admiten ${MAX_FILES} archivos`); break; }
    selected.push({ file, line: lineFromFileName(file.name) });
  }
  renderFiles();
  if (skipped.length) message(`No se agregaron algunos archivos: ${skipped.join('; ')}.`, true);
}

input.addEventListener('change', () => {
  addFiles([...input.files]);
  input.value = '';
});
let dragDepth = 0;
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((type) => {
  zone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (type === 'dragenter') dragDepth++;
    if (type === 'dragover') event.dataTransfer.dropEffect = 'copy';
    if (type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
    if (type === 'drop') {
      dragDepth = 0;
      addFiles([...event.dataTransfer.files]);
    }
    zone.classList.toggle('is-dragging', dragDepth > 0);
  });
});

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const antennaText = (record) => [record.ubicacion, record.lugar].filter(Boolean).join(' · ')
  || `${record.lat.toFixed(6)}, ${record.lng.toFixed(6)}`;
const cell = (text, className = '') => {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
};

let data = null;
let lineFilter = null;
let pairFilter = null;
let coordinateFilter = null;
let page = 1;
const coordinateKey = (record) => `${record.lat.toFixed(6)},${record.lng.toFixed(6)}`;
const hasLine = (match) => !lineFilter || match.a.line === lineFilter || match.b.line === lineFilter;
const mapMatches = () => data.matches.filter((match) => hasLine(match) && (!pairFilter || match.pair === pairFilter));
const visibleMatches = () => mapMatches().filter((match) => (!coordinateFilter || coordinateKey(match.a) === coordinateFilter || coordinateKey(match.b) === coordinateFilter));

if (!window.L) {
  message('No fue posible cargar el mapa. Revisa tu conexión y recarga la página.', true);
  input.disabled = true;
} else {
  const map = L.map('matchesMap', { preferCanvas: true }).setView([29.0729, -110.9559], 12);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    referrerPolicy: 'strict-origin-when-cross-origin',
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  let warnedTiles = false;
  tiles.on('tileerror', () => {
    if (!warnedTiles) {
      warnedTiles = true;
      message('No se pudo cargar el mapa de fondo. Revisa tu conexión; las coincidencias siguen disponibles.', true);
    }
  });
  L.control.scale({ imperial: false }).addTo(map);
  const layers = L.featureGroup().addTo(map);

  function fit() {
    const bounds = layers.getBounds();
    if (!bounds.isValid()) return;
    map.stop();
    map.invalidateSize({ pan: false });
    map.fitBounds(bounds, { padding: [25, 25], maxZoom: 17, animate: false });
  }

  function drawMap() {
    layers.clearLayers();
    const matches = mapMatches();
    const sites = new Map();
    const links = new Set();
    for (const match of matches) {
      for (const record of [match.a, match.b]) {
        const key = coordinateKey(record);
        if (!sites.has(key)) sites.set(key, { record, lines: new Set(), count: 0 });
        const site = sites.get(key);
        site.lines.add(record.line);
        site.count++;
      }
      if (!match.sameAntenna) {
        const link = [coordinateKey(match.a), coordinateKey(match.b)].sort().join('|');
        if (!links.has(link)) {
          links.add(link);
          L.polyline([[match.a.lat, match.a.lng], [match.b.lat, match.b.lng]],
            { color: '#e07800', weight: 2, dashArray: '6 6' }).addTo(layers);
        }
      }
    }
    for (const [key, site] of sites) {
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = antennaText(site.record);
      const detail = document.createElement('div');
      detail.textContent = `Líneas: ${[...site.lines].join(', ')}`;
      popup.append(title, detail);
      L.circleMarker([site.record.lat, site.record.lng], {
        radius: 7, color: '#1f1f1f', weight: 1.5, fillColor: site.lines.size > 1 ? '#d43d2f' : '#087cf0', fillOpacity: 0.9,
      }).bindPopup(popup).on('click', () => {
        coordinateFilter = coordinateFilter === key ? null : key;
        page = 1;
        renderDetail();
      }).addTo(layers);
    }
  }

  // The select lists every analysed line; files merged into one line say how many they were.
  function renderLineOptions() {
    const all = new Option('Todas las líneas', '');
    const options = data.lines.map((entry) => new Option(entry.files.length > 1
      ? `${entry.line} (${entry.files.length} archivos)` : entry.line, entry.line));
    byId('matchesLine').replaceChildren(all, ...options);
    byId('matchesLine').value = lineFilter || '';
  }

  function renderLineInfo() {
    const info = byId('matchesLineInfo');
    info.hidden = !lineFilter;
    if (!lineFilter) return;
    const others = data.pairs.filter((pair) => pair.lines.includes(lineFilter))
      .map((pair) => `${pair.lines.find((line) => line !== lineFilter)} (${pair.count})`);
    info.textContent = others.length
      ? `La línea ${lineFilter} coincidió con ${others.length} ${others.length === 1 ? 'línea' : 'líneas'}: ${others.join(', ')}.`
      : `La línea ${lineFilter} no coincidió con ninguna otra línea con estos criterios.`;
  }

  function renderPairs() {
    const rows = data.pairs.filter((pair) => !lineFilter || pair.lines.includes(lineFilter)).map((pair) => {
      const row = document.createElement('tr');
      row.className = 'matches-pair' + (pairFilter === pair.key ? ' matches-pair-selected' : '');
      row.tabIndex = 0;
      row.setAttribute('aria-pressed', String(pairFilter === pair.key));
      // With a line selected it goes first, so the column reads as "selected ↔ the line it met".
      const lines = lineFilter ? [lineFilter, pair.lines.find((line) => line !== lineFilter)] : pair.lines;
      row.append(cell(lines.join(' ↔ ')), cell(pair.count, 'text-end'), cell(pair.sameAntenna, 'text-end'),
        cell(`${pair.minDistance} m`, 'text-end'), cell(`${pair.first} / ${pair.last}`), cell(pair.places.join('; ') || 'Sin ubicación registrada'));
      const toggle = () => {
        pairFilter = pairFilter === pair.key ? null : pair.key;
        coordinateFilter = null;
        page = 1;
        renderPairs();
        drawMap();
        fit();
        renderDetail();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
      return row;
    });
    if (!rows.length) {
      const row = document.createElement('tr');
      const empty = cell(lineFilter ? `La línea ${lineFilter} no coincidió con ninguna otra.` : 'No hubo coincidencias con estos criterios.', 'text-center text-muted py-4');
      empty.colSpan = 6;
      row.append(empty);
      rows.push(row);
    }
    byId('matchesPairs').replaceChildren(...rows);
  }

  function renderDetail() {
    const matches = visibleMatches();
    const pages = Math.max(Math.ceil(matches.length / PAGE_SIZE), 1);
    page = Math.min(page, pages);
    const rows = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((match) => {
      const row = document.createElement('tr');
      row.append(cell(`${match.a.line} (${match.a.file})`), cell(match.a.time), cell(antennaText(match.a)),
        cell(`${match.b.line} (${match.b.file})`), cell(match.b.time), cell(antennaText(match.b)),
        cell(match.gapMinutes, 'text-end'), cell(match.sameAntenna ? 'Misma antena' : match.distance, 'text-end'));
      return row;
    });
    byId('matchesRows').replaceChildren(...rows);
    const filters = [lineFilter && `línea ${lineFilter}`, pairFilter && 'par seleccionado', coordinateFilter && 'antena seleccionada en el mapa'].filter(Boolean);
    byId('matchesDetailInfo').textContent = `${matches.length} coincidencias${filters.length ? ` (${filters.join(', ')})` : ''}.`
      + (data.truncated ? ` El detalle muestra las primeras ${data.matches.length} de ${data.total}; los totales por par sí cuentan todas.` : '');
    byId('matchesClearFilter').hidden = !lineFilter && !pairFilter && !coordinateFilter;
    document.querySelector('.matches-pager').hidden = pages < 2;
    byId('matchesPageInfo').textContent = `Página ${page} de ${pages}`;
    byId('matchesPrev').disabled = page <= 1;
    byId('matchesNext').disabled = page >= pages;
  }

  function renderFileSummary() {
    byId('matchesFileSummary').replaceChildren(...data.files.map((file) => {
      const row = document.createElement('tr');
      row.append(cell(file.line), cell(file.name), cell(file.total, 'text-end'), cell(file.usable, 'text-end'),
        cell(file.hasDate ? file.withoutTime : 'Sin columna de fecha', 'text-end'), cell(file.withoutPosition, 'text-end'));
      return row;
    }));
  }

  byId('matchesFit').addEventListener('click', fit);
  byId('matchesLine').addEventListener('change', (event) => {
    lineFilter = event.target.value || null;
    pairFilter = null;
    coordinateFilter = null;
    page = 1;
    renderLineInfo();
    renderPairs();
    drawMap();
    fit();
    renderDetail();
  });
  byId('matchesClearFilter').addEventListener('click', () => {
    lineFilter = null;
    byId('matchesLine').value = '';
    renderLineInfo();
    pairFilter = null;
    coordinateFilter = null;
    page = 1;
    renderPairs();
    drawMap();
    fit();
    renderDetail();
  });
  byId('matchesPrev').addEventListener('click', () => { page--; renderDetail(); });
  byId('matchesNext').addEventListener('click', () => { page++; renderDetail(); });
  byId('matchesExport').addEventListener('click', () => {
    const header = ['Línea A', 'Archivo A', 'Fila A', 'Fecha y hora A', 'Ubicación A', 'Lugar A', 'Latitud A', 'Longitud A',
      'Línea B', 'Archivo B', 'Fila B', 'Fecha y hora B', 'Ubicación B', 'Lugar B', 'Latitud B', 'Longitud B',
      'Diferencia (minutos)', 'Distancia (metros)', 'Misma antena'];
    const side = (record) => [record.line, record.file, record.row, record.time, record.ubicacion, record.lugar, record.lat, record.lng];
    const lines = [header, ...visibleMatches().map((match) => [...side(match.a), ...side(match.b),
      match.gapMinutes, match.distance, match.sameAntenna ? 'Sí' : 'No'])];
    download('coincidencias.csv', `﻿${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`);
  });

  // Back to an empty page: no files, no results and the default minutes and metres.
  byId('matchesClear').addEventListener('click', async () => {
    if ((selected.length || data) && !(await window.confirmToast('¿Quitar los archivos y los resultados del tablero?', { action: 'Limpiar' }))) return;
    selected = [];
    data = null;
    lineFilter = null;
    pairFilter = null;
    coordinateFilter = null;
    page = 1;
    form.reset();
    layers.clearLayers();
    byId('matchesResults').hidden = true;
    renderFiles();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (selected.length < 2 || !minutes.reportValidity() || !metres.reportValidity()) return;
    const emptyLine = selected.find((entry) => !entry.line.trim());
    if (emptyLine) return message(`Escribe la línea de ${emptyLine.file.name}.`, true);
    if (new Set(selected.map((entry) => entry.line.trim())).size < 2) {
      return message('Todos los archivos tienen la misma línea; asigna al menos dos líneas distintas.', true);
    }
    const body = new FormData();
    body.append('minutos', minutes.value);
    body.append('metros', metres.value);
    for (const entry of selected) {
      body.append('archivos', entry.file, entry.file.name);
      body.append('linea', entry.line.trim());
    }
    submit.disabled = true;
    message(`Analizando ${selected.length} archivos…`);
    try {
      const response = await fetch('/coincidencias/buscar', { method: 'POST', body });
      if (response.redirected) throw new Error('Tu sesión terminó. Vuelve a iniciar sesión para buscar coincidencias.');
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result.pairs)) throw new Error(result.error || 'No fue posible analizar los archivos.');
      data = result;
      lineFilter = null;
      pairFilter = null;
      coordinateFilter = null;
      page = 1;
      byId('matchesResults').hidden = false;
      renderFileSummary();
      renderLineOptions();
      renderLineInfo();
      renderPairs();
      drawMap();
      renderDetail();
      requestAnimationFrame(fit);
      const duplicates = data.lines.reduce((sum, entry) => sum + entry.duplicates, 0);
      message((data.total
        ? `${data.total} coincidencias entre ${data.pairs.length} pares de líneas a ${data.minutes} minutos o menos y ${data.metres} metros o menos.`
        : `No hubo registros de líneas distintas a ${data.minutes} minutos o menos y ${data.metres} metros o menos.`)
        + (duplicates ? ` Se omitieron ${duplicates} registros repetidos entre archivos de la misma línea.` : ''));
    } catch (error) {
      message(error.message, true);
    } finally {
      submit.disabled = selected.length < 2;
    }
  });
}
