import { coverageSector } from './planeacion-geometry.js?v=6';
import { summarizeAntennas, antennaClipboardText, rowMatches, frequencyScale, selectionCsv } from './planeacion-antenas.js?v=6';

const byId = (id) => document.getElementById(id);
const status = byId('planningStatus');
const PAGE_SIZE = 200;
// The last import survives a reload of this tab only, and only for the user who imported it.
const STORAGE_PREFIX = 'planeacion-geografica-ultima:';
const STORAGE_KEY = STORAGE_PREFIX + (document.querySelector('.planning-page')?.dataset.user || '');
const STORAGE_LIMIT = 4_500_000;

async function copyAntenna(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    (document.fullscreenElement || document.body).append(input);
    const previousFocus = document.activeElement;
    try {
      input.select();
      if (!document.execCommand('copy')) throw new Error('No fue posible copiar la antena.');
    } finally {
      input.remove();
      previousFocus?.focus({ preventScroll: true });
    }
  }
}
function message(text, error = false) {
  status.textContent = text;
  status.className = 'alert ' + (error ? 'alert-danger' : 'alert-info');
}
function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const safeLine = (line) => String(line).replace(/[^a-zA-Z0-9_-]/g, '_');

if (!window.L) {
  message('No fue posible cargar el mapa. Revisa tu conexión y recarga la página.', true);
  byId('planningSubmit').disabled = true;
} else {
  const map = L.map('planningMap', { preferCanvas: true }).setView([29.0729, -110.9559], 12);
  const mapElement = byId('planningMap');
  const fullscreenControl = L.control({ position: 'topright' });
  let fullscreenButton;
  let expanded = false;
  function updateFullscreen() {
    const active = document.fullscreenElement === mapElement || expanded;
    fullscreenButton.textContent = active ? 'Salir de pantalla completa' : 'Pantalla completa';
    fullscreenButton.setAttribute('aria-pressed', String(active));
    requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  }
  function setExpanded(value) {
    expanded = value;
    mapElement.classList.toggle('planning-map-expanded', value);
    document.body.classList.toggle('planning-map-open', value);
    updateFullscreen();
  }
  fullscreenControl.onAdd = () => {
    const container = L.DomUtil.create('div', 'leaflet-bar planning-fullscreen-control');
    fullscreenButton = L.DomUtil.create('button', '', container);
    fullscreenButton.type = 'button';
    fullscreenButton.setAttribute('aria-controls', 'planningMap');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    fullscreenButton.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === mapElement) {
          await document.exitFullscreen();
        } else if (expanded) {
          setExpanded(false);
        } else if (document.fullscreenEnabled && mapElement.requestFullscreen) {
          await mapElement.requestFullscreen();
        } else {
          setExpanded(true);
        }
      } catch {
        // Keep an expanded map available when native fullscreen is restricted.
        setExpanded(true);
      }
    });
    return container;
  };
  fullscreenControl.addTo(map);
  document.addEventListener('fullscreenchange', updateFullscreen);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && expanded) setExpanded(false);
  });
  updateFullscreen();
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    referrerPolicy: 'strict-origin-when-cross-origin',
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  let warnedTiles = false;
  tiles.on('tileerror', () => {
    if (!warnedTiles) {
      warnedTiles = true;
      message('No se pudo cargar el mapa de fondo. Revisa tu conexión; los sectores siguen disponibles.', true);
    }
  });
  L.control.scale({ imperial: false }).addTo(map);

  const legendControl = L.control({ position: 'bottomright' });
  let legendElement;
  legendControl.onAdd = () => {
    legendElement = L.DomUtil.create('div', 'planning-legend');
    legendElement.hidden = true;
    return legendElement;
  };
  legendControl.addTo(map);
  function renderLegend(scale) {
    legendElement.hidden = !scale;
    if (!scale) return;
    const title = document.createElement('strong');
    title.textContent = 'Registros por punto';
    const items = scale.legend.map(({ color, label }) => {
      const item = document.createElement('div');
      const swatch = document.createElement('span');
      swatch.className = 'planning-legend-swatch';
      swatch.style.background = color;
      item.append(swatch, label);
      return item;
    });
    legendElement.replaceChildren(title, ...items);
  }

  const layers = L.featureGroup().addTo(map);
  let data = null;
  const selectedRows = new Set();
  let selectionActive = false;
  let pointsByRow = new Map();
  let coordinateFilter = null;
  let page = 1;
  const coordinateKey = (point) => point ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : null;
  const coverageMode = byId('planningCoverageMode');
  const radius = byId('planningRadius');
  const beam = byId('planningBeam');
  const colorMode = byId('planningColorMode');
  const from = byId('planningFrom');
  const to = byId('planningTo');
  const search = byId('planningSearch');

  const timeFilterActive = () => Boolean(data?.hasTimes && (from.value || to.value));
  function inPeriod(rowNumber) {
    if (!timeFilterActive()) return true;
    const time = data.times?.[rowNumber];
    return Boolean(time) && (!from.value || time >= from.value) && (!to.value || time <= to.value);
  }

  function antennaSummary() {
    const fragment = document.createDocumentFragment();
    for (const group of summarizeAntennas(data)) {
      const item = document.createElement('div');
      item.className = 'planning-antenna-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planning-antenna';
      const title = document.createElement('strong');
      title.textContent = `${group.name} · ${group.rows.length} registros`;
      const location = document.createElement('span');
      location.textContent = `Ubicación: ${group.ubicacion || 'Sin información'} · Lugar: ${group.lugar || 'Sin información'}`;
      const coordinates = document.createElement('span');
      coordinates.textContent = group.coordinates;
      button.append(title, location, coordinates);
      button.addEventListener('click', () => {
        if (!radius.reportValidity()) return;
        selectedRows.clear();
        group.points.forEach((point) => selectedRows.add(point.row));
        selectionActive = true;
        coordinateFilter = null;
        page = 1;
        table();
        draw({ fit: true });
        const description = document.createElement('div');
        description.textContent = `${group.name} · ${group.ubicacion} · ${group.lugar} · ${group.rows.length} registros`;
        if (group.points.length) {
          const point = group.points[0];
          L.popup().setLatLng([point.lat, point.lng]).setContent(description).openOn(map);
          mapElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          message(`${group.name}: ${group.rows.length} registros sin coordenadas válidas para mostrar en el mapa.`, true);
        }
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-sm btn-outline-secondary planning-copy';
      copy.textContent = 'Copiar';
      copy.setAttribute('aria-label', `Copiar ${group.name} al portapapeles`);
      copy.addEventListener('click', () => {
        copyAntenna(antennaClipboardText(group, data.rows.length))
          .then(() => {
            copy.textContent = 'Copiado';
            setTimeout(() => { copy.textContent = 'Copiar'; }, 1500);
          })
          .catch(() => message('No fue posible copiar la antena al portapapeles. Intenta de nuevo.', true));
      });
      item.append(button, copy);
      fragment.append(item);
    }
    byId('planningAntennas').replaceChildren(fragment);
  }
  function showCoordinateRecords(point) {
    coordinateFilter = coordinateKey(point);
    page = 1;
    table();
    byId('planningData').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function fit() {
    const bounds = layers.getBounds();
    if (bounds.isValid()) {
      // A second fit during an active Leaflet zoom can retain the first bounds.
      map.stop();
      map.invalidateSize({ pan: false });
      map.fitBounds(bounds, { padding: [25, 25], maxZoom: 17, animate: false });
    }
  }
  // Only a new file or a new selection re-frames the map; style changes keep the current view.
  function draw({ fit: shouldFit = false } = {}) {
    if (!data || !radius.reportValidity()) return;
    layers.clearLayers();
    const seen = new Set();
    const points = selectionActive
      ? [...selectedRows].map((row) => pointsByRow.get(row)).filter(Boolean)
      : data.points.filter((point) => inPeriod(point.row));
    const counts = new Map();
    for (const point of points) counts.set(coordinateKey(point), (counts.get(coordinateKey(point)) || 0) + 1);
    const scale = !selectionActive && colorMode.value === 'frequency' && points.length
      ? frequencyScale(Math.max(...counts.values())) : null;
    const selectionColors = ['#087cf0', '#e07800', '#8a35c9', '#168449', '#cf3555', '#008b98'];
    for (const [index, point] of points.entries()) {
      const bearing = point.azimuth;
      const key = `${point.lat},${point.lng},${coverageMode.value === 'range' && bearing !== null ? 'range' : bearing}`;
      if (!selectionActive && seen.has(key)) continue;
      seen.add(key);
      const color = selectionActive ? selectionColors[index % selectionColors.length]
        : scale ? scale.colorFor(counts.get(coordinateKey(point))) : '#087cf0';
      if (bearing !== null) {
        const style = { color, weight: 1.5, fillColor: color, fillOpacity: 0.22, interactive: false };
        if (coverageMode.value === 'range') {
          L.circle([point.lat, point.lng], { ...style, radius: Number(radius.value) }).addTo(layers);
        } else {
          L.polygon(coverageSector(point.lat, point.lng, bearing, Number(radius.value), Number(beam.value)), style).addTo(layers);
        }
      }
      // A dark outline keeps every point visible over roads, parks and water.
      L.circleMarker([point.lat, point.lng], {
        radius: selectionActive ? 7 : 6, color: '#1f1f1f', weight: 1.5, fillColor: color, fillOpacity: 1, interactive: true,
      }).on('click', () => showCoordinateRecords(point)).addTo(layers);
    }
    renderLegend(scale);
    byId('planningFit').disabled = !data.points.length;
    byId('planningExportSelection').disabled = !selectionActive || selectedRows.size === 0;
    const period = timeFilterActive() ? ` en el periodo elegido` : '';
    if (selectionActive && selectedRows.size === 1) {
      const selectedRow = [...selectedRows][0];
      const point = pointsByRow.get(selectedRow);
      message(point.azimuth === null
        ? `Registro ${selectedRow}: antena sin azimut en el archivo; se muestra únicamente su ubicación.`
        : coverageMode.value === 'range'
          ? `Registro ${selectedRow}: solo rango de ${radius.value} m, sin dirección.`
          : `Registro ${selectedRow}: azimut ${point.azimuth}°, apertura ${beam.value}°. Alcance: ${radius.value} m.`);
    } else if (selectionActive) {
      message(`${selectedRows.size} registros seleccionados; ${seen.size} ubicaciones y orientaciones representadas. ${selectedRows.size ? `Alcance: ${radius.value} m. Los registros sin azimut muestran únicamente la antena.` : 'Selecciona registros o usa “Ver todas las antenas”.'}`);
    } else {
      message(`${points.length} de ${data.rows.length} registros con coordenadas${period}; ${seen.size} ubicaciones y orientaciones representadas. ${data.omitted} registros sin coordenadas válidas. ${data.missingAzimuth} registros sin azimut válido muestran únicamente la antena.`);
    }
    if (shouldFit) fit();
  }
  function table() {
    const visible = [];
    for (const [offset, row] of data.rows.entries()) {
      const rowNumber = offset + 1;
      if (coordinateFilter !== null && coordinateKey(pointsByRow.get(rowNumber)) !== coordinateFilter) continue;
      if (!inPeriod(rowNumber) || !rowMatches(row, search.value)) continue;
      visible.push(rowNumber);
    }
    const totalPages = Math.max(Math.ceil(visible.length / PAGE_SIZE), 1);
    page = Math.min(Math.max(page, 1), totalPages);
    const fragment = document.createDocumentFragment();
    for (const rowNumber of visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
      const row = data.rows[rowNumber - 1];
      const tr = document.createElement('tr');
      tr.dataset.row = String(rowNumber);
      tr.classList.add('planning-record');
      tr.classList.toggle('planning-record-selected', selectedRows.has(rowNumber));
      const selectionCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedRows.has(rowNumber);
      checkbox.disabled = !pointsByRow.has(rowNumber);
      checkbox.setAttribute('aria-label', `Seleccionar registro ${rowNumber}`);
      if (checkbox.disabled) checkbox.title = 'El registro no tiene coordenadas válidas';
      selectionCell.append(checkbox);
      tr.append(selectionCell);
      const select = () => {
        if (!pointsByRow.has(rowNumber)) {
          message(`El registro ${rowNumber} no tiene coordenadas válidas para mostrar su antena.`, true);
          return;
        }
        if (!radius.reportValidity()) return;
        selectionActive = true;
        if (selectedRows.has(rowNumber)) selectedRows.delete(rowNumber);
        else selectedRows.add(rowNumber);
        highlightSelection();
        draw({ fit: true });
      };
      // The checkbox is the keyboard control; clicking anywhere on the row is a mouse shortcut.
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
        select();
        checkbox.checked = selectedRows.has(rowNumber);
      });
      tr.addEventListener('click', select);
      for (let column = 0; column < data.headers.length; column++) {
        const td = document.createElement('td');
        td.textContent = row[column] ?? '';
        tr.append(td);
      }
      fragment.append(tr);
    }
    if (!visible.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = data.headers.length + 1;
      td.className = 'text-center text-muted py-4';
      td.textContent = 'Ningún registro coincide con los filtros.';
      tr.append(td);
      fragment.append(tr);
    }
    byId('planningRows').replaceChildren(fragment);
    const filters = [
      coordinateFilter === null ? '' : `Coordenadas: ${coordinateFilter}`,
      timeFilterActive() ? 'Periodo filtrado' : '',
      search.value.trim() ? `Búsqueda: “${search.value.trim()}”` : '',
    ].filter(Boolean).join(' · ');
    byId('planningFile').textContent = `${data.name} · Línea ${data.line} · ${visible.length} de ${data.rows.length} registros${filters ? ` · ${filters}` : ''}`;
    byId('planningClearFilter').hidden = coordinateFilter === null;
    const pager = document.querySelector('.planning-pager');
    pager.hidden = totalPages <= 1;
    byId('planningPageInfo').textContent = `Página ${page} de ${totalPages}`;
    byId('planningPrev').disabled = page <= 1;
    byId('planningNext').disabled = page >= totalPages;
  }
  function highlightSelection() {
    const body = byId('planningRows');
    for (const previous of body.querySelectorAll('.planning-record-selected')) {
      previous.classList.remove('planning-record-selected');
      previous.querySelector('input[type="checkbox"]').checked = false;
    }
    for (const selectedRow of selectedRows) {
      const current = body.querySelector(`[data-row="${selectedRow}"]`);
      current?.classList.add('planning-record-selected');
      if (current) current.querySelector('input[type="checkbox"]').checked = true;
    }
  }
  function load(result, { restored = false } = {}) {
    data = { times: {}, hasTimes: false, ...result };
    selectedRows.clear();
    selectionActive = false;
    coordinateFilter = null;
    page = 1;
    search.value = '';
    search.disabled = false;
    from.value = '';
    to.value = '';
    const times = Object.values(data.times).sort();
    byId('planningTimeFilter').hidden = !data.hasTimes;
    for (const input of [from, to]) {
      input.min = times[0] || '';
      input.max = times.at(-1) || '';
    }
    pointsByRow = new Map(data.points.map((point) => [point.row, point]));
    antennaSummary();
    const tr = document.createElement('tr');
    const selectionHeader = document.createElement('th');
    selectionHeader.scope = 'col';
    selectionHeader.textContent = 'Seleccionar';
    tr.append(selectionHeader);
    for (const header of data.headers) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = header;
      tr.append(th);
    }
    byId('planningHeaders').replaceChildren(tr);
    map.invalidateSize({ pan: false });
    byId('planningExport').disabled = false;
    table();
    draw({ fit: true });
    byId('planningRestored').hidden = !restored;
    if (restored) byId('planningRestoredText').textContent = `Se recuperó la última importación de esta pestaña: ${data.name} · Línea ${data.line}.`;
  }
  function clearStored() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  }

  byId('planningUpload').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = byId('archivo').files[0];
    if (file?.size > 20 * 1024 * 1024) return message('El archivo supera el límite de 20 MB.', true);
    byId('planningSubmit').disabled = true;
    message('Procesando archivo y completando ubicaciones…');
    try {
      const response = await fetch('/planeacion-geografica/importar', {
        method: 'POST', body: new FormData(event.target),
      });
      if (response.redirected || response.status === 401) {
        message('Tu sesión terminó. Vuelve a iniciar sesión para importar el archivo.', true);
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No fue posible importar el archivo.');
      load(result);
      clearStored();
      try {
        const serialized = JSON.stringify(result);
        if (serialized.length <= STORAGE_LIMIT) sessionStorage.setItem(STORAGE_KEY, serialized);
      } catch { /* Too large or storage disabled: the map still works, it just won't survive a reload. */ }
    } catch (error) {
      message(error.message || 'No fue posible conectar con el servidor.', true);
    } finally {
      byId('planningSubmit').disabled = false;
    }
  });
  coverageMode.addEventListener('change', () => draw());
  beam.addEventListener('change', () => draw());
  radius.addEventListener('change', () => draw());
  colorMode.addEventListener('change', () => draw());
  const periodChanged = () => {
    if (!data) return;
    if (from.value && to.value && from.value > to.value) {
      message('La fecha inicial no puede ser posterior a la final.', true);
      return;
    }
    page = 1;
    table();
    draw();
  };
  from.addEventListener('change', periodChanged);
  to.addEventListener('change', periodChanged);
  byId('planningClearTime').addEventListener('click', () => {
    from.value = '';
    to.value = '';
    periodChanged();
  });
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!data) return;
      page = 1;
      table();
    }, 200);
  });
  byId('planningPrev').addEventListener('click', () => { page--; table(); });
  byId('planningNext').addEventListener('click', () => { page++; table(); });
  byId('planningClearFilter').addEventListener('click', () => {
    if (!data) return;
    coordinateFilter = null;
    page = 1;
    table();
  });
  byId('planningFit').addEventListener('click', () => {
    if (!data || !radius.reportValidity()) return;
    selectedRows.clear();
    selectionActive = false;
    coordinateFilter = null;
    table();
    draw({ fit: true });
  });
  byId('planningExport').addEventListener('click', () => {
    if (data) download(`Planeacion-${safeLine(data.line)}.csv`, data.csv);
  });
  byId('planningExportSelection').addEventListener('click', () => {
    if (!data || !selectedRows.size) return;
    download(`Planeacion-${safeLine(data.line)}-seleccion.csv`, selectionCsv(data.headers, data.rows, selectedRows));
  });
  byId('planningDiscard').addEventListener('click', () => {
    clearStored();
    window.location.reload();
  });

  let stored = null;
  try {
    // Someone else may have used this tab before logging out; drop their file.
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(STORAGE_PREFIX) && key !== STORAGE_KEY) sessionStorage.removeItem(key);
    }
    stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  } catch { stored = null; }
  if (stored?.rows && stored?.headers && stored?.points) load(stored, { restored: true });
}
