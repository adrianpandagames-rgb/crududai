import { coverageSector, adjustSaturation } from './planeacion-geometry.js?v=7';
import { COVERAGE_PALETTES, DEFAULT_PALETTE, paletteById } from './planeacion-paletas.js?v=1';
import {
  summarizeAntennas, antennaClipboardText, antennaClipboardHtml, rowMatches, frequencyScale, selectionCsv, antennaNumbers, antennaColumns,
} from './planeacion-antenas.js?v=10';
import { findOvernightLocations } from './planeacion-pernocta.js?v=3';
import { summarizeContacts, contactCells, contactsCsv, formatContactTime } from './planeacion-contactos.js?v=1';
import {
  findLastCommunications, COMMUNICATION_KINDS, lastCommunicationCells, lastCommunicationClipboard,
} from './planeacion-ultima.js?v=5';

const byId = (id) => document.getElementById(id);
const status = byId('planningStatus');
const PAGE_SIZE = 200;
// Red map pin with a dark centre, drawn under the antenna number in the "Ruta" view.
const ROUTE_PIN = '<svg viewBox="0 0 24 34" width="28" height="40" aria-hidden="true">'
  + '<path d="M12 1C5.9 1 1 5.8 1 11.8 1 20 12 33 12 33s11-13 11-21.2C23 5.8 18.1 1 12 1z" fill="#d93a2b" stroke="#a3261b" stroke-width="1.2"/>'
  + '<circle cx="12" cy="12" r="4.2" fill="#7a1a12"/></svg>';
// Imported files live only in this page: leaving or reloading it discards them. Earlier versions
// kept the last import in sessionStorage; wipe anything they left behind.
try {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('planeacion-geografica-ultima')) sessionStorage.removeItem(key);
  }
} catch { /* Storage may be disabled; nothing was saved then. */ }

// Puts the row on the clipboard both as a table, which Excel pastes cell by cell, and as tab-separated text
// for everything else.
async function copyAntenna(text, html) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    return;
  } catch {
    // Without the async clipboard (plain HTTP, older browsers) the copy event can still carry both formats.
    const fill = (event) => {
      event.clipboardData.setData('text/html', html);
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    };
    document.addEventListener('copy', fill, { once: true });
    try {
      if (!document.execCommand('copy')) throw new Error('No fue posible copiar la antena.');
    } finally {
      document.removeEventListener('copy', fill);
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
// Exports are named after the imported file, without its extension.
const baseName = (name) => safeLine(String(name).replace(/.[^.]+$/, ''));

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
  // Fills are drawn opaque in their own pane and the pane itself is made transparent, so overlapping sectors
  // keep the same transparency instead of piling up. Outlines sit in a pane above, always fully visible.
  const fillPane = map.createPane('coverageFill');
  fillPane.style.zIndex = '390';
  fillPane.style.pointerEvents = 'none';
  const linePane = map.createPane('coverageLine');
  linePane.style.zIndex = '395';
  linePane.style.pointerEvents = 'none';
  function renderLegend(scale) {
    legendElement.hidden = !scale;
    if (!scale) return;
    const title = document.createElement('strong');
    title.textContent = selectionActive ? 'Registros seleccionados por punto' : 'Registros por punto';
    const tone = (color) => adjustSaturation(color, saturation.value);
    // The bar shows the whole palette; the rows below give the count each colour stands for, most first.
    const bar = document.createElement('div');
    bar.className = 'planning-legend-bar';
    bar.style.background = `linear-gradient(to right, ${paletteById(paletteId).colors.map(tone).join(', ')})`;
    const ends = document.createElement('div');
    ends.className = 'planning-legend-ends';
    const fewer = document.createElement('span');
    fewer.textContent = 'Menos';
    const more = document.createElement('span');
    more.textContent = 'Más';
    ends.append(fewer, more);
    const items = [...scale.legend].reverse().map(({ color, label }) => {
      const item = document.createElement('div');
      const swatch = document.createElement('span');
      swatch.className = 'planning-legend-swatch';
      swatch.style.background = tone(color);
      item.append(swatch, label);
      return item;
    });
    legendElement.replaceChildren(title, bar, ends, ...items);
  }

  const layers = L.featureGroup().addTo(map);
  const overnightLayer = L.layerGroup().addTo(map);
  let data = null;
  const selectedRows = new Set();
  let selectionActive = false;
  let pointsByRow = new Map();
  let numbers = new Map();
  let antennaGroups = [];
  let coordinateFilter = null;
  let page = 1;
  const coordinateKey = (point) => point ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : null;
  const coverageMode = byId('planningCoverageMode');
  const radius = byId('planningRadius');
  const beam = byId('planningBeam');
  const colorMode = byId('planningColorMode');
  const rangeMode = byId('planningRangeMode');
  const operator = byId('planningOperator');
  // Estimated reach per antenna and azimuth, asked to the server for the chosen operator.
  let estimates = null;
  let estimateRequest = 0;
  const estimateKey = (point) => `${point.lat},${point.lng},${point.azimuth}`;
  const estimateFor = (point) => (rangeMode.value === 'estimated' ? estimates?.get(estimateKey(point)) : null) || null;
  const rangeFor = (point) => estimateFor(point)?.range ?? Number(radius.value);
  // Antennas without a neighbour get no estimate and keep the fixed reach, drawn with a dashed outline.
  const isEstimated = (point) => estimateFor(point)?.range != null;
  const SOURCES = { opencellid: 'sitio de OpenCelliD', archivo: 'otra antena del archivo' };
  const describeEstimate = (estimate) => (estimate.range != null
    ? `${estimate.range} m estimados (${SOURCES[estimate.source] || 'vecino'} a ${estimate.neighbour} m)`
    : `${radius.value} m fijos (${estimate.method === 'sin-datos'
      ? 'sin sitios conocidos a 15 km' : 'sin sitios al frente'}; no se pudo estimar)`);
  const reachSummary = () => {
    if (rangeMode.value !== 'estimated' || !estimates) return `${radius.value} m`;
    const all = [...estimates.values()];
    const ranges = all.filter((estimate) => estimate.range != null).map((estimate) => estimate.range).sort((a, b) => a - b);
    const bySource = (source) => all.filter((estimate) => estimate.source === source).length;
    const missing = all.length - ranges.length;
    if (!ranges.length) {
      return `no se pudo estimar ninguna de las ${all.length} antenas (no hay sitios de ${operator.selectedOptions[0].text}`
        + ` en OpenCelliD ni otras antenas del archivo al frente); se usa el alcance fijo de ${radius.value} m`;
    }
    return `estimado de ${ranges[0]} a ${ranges.at(-1)} m para ${ranges.length} de ${all.length} antenas`
      + ` (${bySource('opencellid')} por sitios de ${operator.selectedOptions[0].text} en OpenCelliD, ${bySource('archivo')} por otras antenas del archivo)`
      + `${missing ? `; ${missing} sin vecinos usan el alcance fijo de ${radius.value} m (contorno punteado)` : ''}`;
  };
  async function requestEstimates() {
    if (!data || rangeMode.value !== 'estimated') return;
    const request = ++estimateRequest;
    const unique = new Map();
    for (const point of data.points) unique.set(estimateKey(point), { lat: point.lat, lng: point.lng, azimuth: point.azimuth });
    const antennas = [...unique.values()];
    if (!antennas.length) return;
    message('Calculando el alcance estimado de cada antena…');
    try {
      const response = await fetch('/planeacion-geografica/alcance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operador: operator.value, antenas: antennas }),
      });
      if (response.redirected || response.status === 401) throw new Error('Tu sesión terminó. Vuelve a iniciar sesión.');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No fue posible calcular el alcance estimado.');
      if (request !== estimateRequest) return;
      estimates = new Map([...unique.keys()].map((key, index) => [key, result.alcances[index]]));
      draw();
    } catch (error) {
      if (request !== estimateRequest) return;
      estimates = null;
      message(`${error.message || 'No fue posible conectar con el servidor.'} Se usa el alcance fijo.`, true);
    }
  }
  const from = byId('planningFrom');
  const to = byId('planningTo');
  const search = byId('planningSearch');
  const nightStart = byId('planningNightStart');
  const nightEnd = byId('planningNightEnd');
  const nightShare = byId('planningNightShare');
  const nightRadius = byId('planningNightRadius');
  const saturation = byId('planningSaturation');
  const opacity = byId('planningOpacity');
  const paletteList = byId('planningPalettes');
  // Coverage appearance is a per-viewer preference, remembered in this browser only.
  const STYLE_KEY = 'planeacion-geografica-estilo';
  const STYLE_DEFAULTS = { palette: DEFAULT_PALETTE, saturation: '100', opacity: '30', markerSize: 'chico' };
  const markerSize = byId('planningMarkerSize');
  // Radius in pixels of the circle that marks each antenna; a selection adds one so it stands out.
  const MARKER_SIZES = { punto: 3, chico: 6, mediano: 9, grande: 13 };
  const MARKER_SIZE_NAMES = { punto: 'Punto', chico: 'Chico', mediano: 'Mediano', grande: 'Grande' };
  // The red pins of "Ruta", "Solo módulos" and selected antennas scale with the same size; Chico is the original pin.
  const PIN_SCALES = { punto: 0.5, chico: 1, mediano: 1.4, grande: 1.85 };
  // "Combinada": the size picked for each antenna (by coordinates); belongs to the loaded file only.
  let antennaSizes = new Map();
  let paletteId = DEFAULT_PALETTE;
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}');
    if (typeof saved.palette === 'string') paletteId = paletteById(saved.palette).id;
    if (typeof saved.saturation === 'string') saturation.value = saved.saturation;
    if (typeof saved.opacity === 'string') opacity.value = saved.opacity;
    if (saved.markerSize in MARKER_SIZES || saved.markerSize === 'combinada') markerSize.value = saved.markerSize;
  } catch { /* Without storage the defaults apply. */ }
  function saveStyle() {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify({
        palette: paletteId, saturation: saturation.value, opacity: opacity.value, markerSize: markerSize.value,
      }));
    } catch { /* Storage may be disabled; the choice lasts until reload. */ }
  }
  const sizeOf = (point) => (markerSize.value === 'combinada'
    ? antennaSizes.get(coordinateKey(point)) || STYLE_DEFAULTS.markerSize
    : markerSize.value);
  // "Combinada": clicking an antenna offers its size and the way to its records.
  function openSizeMenu(point, action = () => showCoordinateRecords(point)) {
    const key = coordinateKey(point);
    const box = document.createElement('div');
    box.className = 'planning-size-menu';
    const title = document.createElement('p');
    title.className = 'small fw-semibold mb-1';
    title.textContent = `Tamaño de la antena${numbers.get(key) ? ` ${numbers.get(key)}` : ''}`;
    const group = document.createElement('div');
    group.className = 'btn-group btn-group-sm mb-2';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Tamaño de esta antena');
    for (const [size, name] of Object.entries(MARKER_SIZE_NAMES)) {
      const button = document.createElement('button');
      button.type = 'button';
      const active = sizeOf(point) === size;
      button.className = `btn ${active ? 'btn-primary' : 'btn-outline-primary'}`;
      button.setAttribute('aria-pressed', String(active));
      button.textContent = name;
      button.addEventListener('click', () => {
        antennaSizes.set(key, size);
        map.closePopup();
        draw();
      });
      group.append(button);
    }
    const records = document.createElement('button');
    records.type = 'button';
    records.className = 'btn btn-sm btn-outline-secondary d-block';
    records.textContent = 'Ver sus registros';
    records.addEventListener('click', () => {
      map.closePopup();
      action();
    });
    box.append(title, group, records);
    L.popup().setLatLng([point.lat, point.lng]).setContent(box).openOn(map);
  }
  // Saturation recolours every swatch too, so each one previews what the map will show.
  function renderPalettes() {
    paletteList.replaceChildren(...COVERAGE_PALETTES.map((palette) => {
      const label = document.createElement('label');
      label.className = 'planning-palette';
      label.title = palette.name;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'planningPalette';
      input.value = palette.id;
      input.checked = palette.id === paletteId;
      const bar = document.createElement('span');
      bar.className = 'planning-palette-bar';
      bar.style.background = `linear-gradient(to right, ${palette.colors.map((color) => adjustSaturation(color, saturation.value)).join(', ')})`;
      const name = document.createElement('span');
      name.className = 'planning-palette-name';
      name.textContent = palette.name;
      label.append(input, bar, name);
      return label;
    }));
  }
  function applyStyleValues() {
    byId('planningSaturationValue').textContent = saturation.value;
    byId('planningOpacityValue').textContent = opacity.value;
    fillPane.style.opacity = String(Number(opacity.value) / 100);
  }
  renderPalettes();
  applyStyleValues();

  const timeFilterActive = () => Boolean(data?.hasTimes && (from.value || to.value));
  function inPeriod(rowNumber) {
    if (!timeFilterActive()) return true;
    const time = data.times?.[rowNumber];
    return Boolean(time) && (!from.value || time >= from.value) && (!to.value || time <= to.value);
  }

  // An option picked in Frecuencia de antenas, Pernocta or Contactos frecuentes replaces whatever was shown before:
  // the map and the table keep only its records. Picking the same option again shows everything.
  // Frecuencia de antenas is the exception: each antenna toggles in or out of a selection of several antennas.
  // `option.ids` holds the picked option ids (several only for antennas).
  let option = null;
  function markOption() {
    for (const button of document.querySelectorAll('[data-option]')) {
      const active = Boolean(option?.ids.has(button.dataset.option));
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderSelectedAntennas();
    renderSelectedLast();
  }
  // The box listing what is picked in a module where several options add up; each chip removes its option.
  function renderSelectedBox(box, items, { title, clear, chip }) {
    box.hidden = !items.length;
    if (!items.length) return box.replaceChildren();
    const head = document.createElement('div');
    head.className = 'planning-selected-head';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'btn btn-sm btn-link p-0';
    clearButton.textContent = 'Quitar todas';
    clearButton.addEventListener('click', clear);
    head.append(heading, clearButton);
    const list = document.createElement('div');
    list.className = 'planning-selected-list';
    for (const item of items) {
      const { badge, text, label, remove } = chip(item);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planning-selected-chip';
      button.setAttribute('aria-label', label);
      if (badge) {
        const number = document.createElement('span');
        number.className = 'planning-overnight-rank';
        number.textContent = badge;
        button.append(number);
      }
      button.append(text, ' ×');
      button.addEventListener('click', remove);
      list.append(button);
    }
    box.replaceChildren(head, list);
  }
  function clearSelection() {
    option = null;
    selectedRows.clear();
    selectionActive = false;
    coordinateFilter = null;
    search.value = '';
    map.closePopup();
    markOption();
  }
  // `groups` (antennas) and `entries` (últimas comunicaciones) mark the modules where several options add up.
  function selectOption({ id, label, rows, popup = null, ids = new Set([id]), groups = null, entries = null }) {
    if (!radius.reportValidity()) return;
    const again = option?.id === id && !groups && !entries;
    clearSelection();
    page = 1;
    if (again || !ids.size) {
      table();
      draw({ fit: true });
      return;
    }
    option = { id, label, rows: new Set(rows), ids, groups, entries };
    rows.filter((row) => pointsByRow.has(row)).forEach((row) => selectedRows.add(row));
    selectionActive = true;
    markOption();
    table();
    draw({ fit: true });
    if (!selectedRows.size) {
      message(`${label}: sus registros no tienen coordenadas válidas para mostrar en el mapa; se listan en la tabla.`, true);
      byId('planningData').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (popup) {
      const description = document.createElement('div');
      description.textContent = popup.text;
      L.popup().setLatLng([popup.lat, popup.lng]).setContent(description).openOn(map);
    }
    mapElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Pernocta, Frecuencia de antenas, Contactos frecuentes and Última comunicación each have a switch that turns the whole module on or off.
  // Off, the module is hidden and its pins leave the map. The choice is remembered in this browser only.
  const MODULES_KEY = 'planeacion-geografica-modulos';
  const MODULE_PREFIX = { overnight: 'pernocta:', antennas: 'antena:', contacts: 'contacto:', last: 'ultima:' };
  const modules = { overnight: true, antennas: true, contacts: true, last: true };
  try {
    const saved = JSON.parse(localStorage.getItem(MODULES_KEY) || '{}');
    for (const name of Object.keys(modules)) if (typeof saved[name] === 'boolean') modules[name] = saved[name];
  } catch { /* Without storage every module starts on. */ }
  function applyModule(name) {
    const toggle = document.querySelector(`input[data-module="${name}"]`);
    toggle.checked = modules[name];
    document.querySelector(`[data-module-body="${name}"]`).hidden = !modules[name];
    if (name === 'contacts') byId('planningContactsExport').disabled = !modules.contacts || !contacts?.contacts.length;
  }
  function setModule(name, on) {
    modules[name] = on;
    try { localStorage.setItem(MODULES_KEY, JSON.stringify(modules)); } catch { /* The choice lasts until reload. */ }
    applyModule(name);
    if (!data) return;
    // A module switched off takes its selected option off the map and the table too.
    if (!on && option?.id.startsWith(MODULE_PREFIX[name])) {
      clearSelection();
      page = 1;
      table();
      draw({ fit: true });
    }
    if (name === 'overnight') overnightSummary();
    if (name === 'last') lastSummary();
    if (coverageMode.value === 'modules') draw({ fit: true });
  }
  for (const name of Object.keys(modules)) {
    document.querySelector(`input[data-module="${name}"]`).addEventListener('change', (event) => setModule(name, event.target.checked));
  }
  // "Restablecer" takes the module's selection off the map and the table and, for Pernocta, puts back the
  // night hours, minimum share and grouping distance the page starts with. The switch stays as it is.
  function resetModule(name) {
    if (name === 'overnight') {
      for (const input of [nightStart, nightEnd, nightShare, nightRadius]) input.value = input.defaultValue;
    }
    if (!data) return;
    if (option?.id.startsWith(MODULE_PREFIX[name])) {
      clearSelection();
      page = 1;
      table();
      draw({ fit: true });
    }
    if (name === 'overnight') {
      overnightSummary();
      if (coverageMode.value === 'modules') draw({ fit: true });
    }
  }
  for (const button of document.querySelectorAll('[data-module-reset]')) {
    button.addEventListener('click', () => resetModule(button.dataset.moduleReset));
  }

  const antennaOptionId = (group) => `antena:${group.name}|${group.coordinates}`;
  // The antenna number of the Ruta view (antena column of its first record, or its order of appearance).
  const antennaNumber = (group) => numbers.get(coordinateKey(group.points[0])) || '';
  // Pressing an antenna adds it to the selection, or removes it when it was already there.
  function showAntenna(group) {
    const id = antennaOptionId(group);
    const current = option?.groups ? [...option.groups] : [];
    const groups = current.some((picked) => antennaOptionId(picked) === id)
      ? current.filter((picked) => antennaOptionId(picked) !== id)
      : [...current, group];
    selectAntennas(groups, groups.length === 1 && groups[0] === group);
  }
  function selectAntennas(groups, withPopup = false) {
    const [first] = groups;
    selectOption({
      id: 'antena:seleccion',
      ids: new Set(groups.map(antennaOptionId)),
      groups,
      label: groups.length === 1 ? `Antena ${antennaNumber(first)}` : `Antenas ${groups.map(antennaNumber).join(', ')}`,
      rows: [...new Set(groups.flatMap((group) => group.rows))],
      popup: withPopup ? {
        lat: first.points[0].lat, lng: first.points[0].lng,
        text: `Antena ${antennaNumber(first)} · ${first.name} · ${first.ubicacion} · ${first.lugar} · ${first.rows.length} registros`,
      } : null,
    });
  }
  // The antennas picked in Frecuencia de antenas, with their number; each can be removed on its own.
  function renderSelectedAntennas() {
    const groups = option?.groups || [];
    const records = new Set(groups.flatMap((group) => group.rows)).size;
    renderSelectedBox(byId('planningAntennasSelected'), groups, {
      title: `${groups.length} ${groups.length === 1 ? 'antena seleccionada' : 'antenas seleccionadas'} · ${records} registros`,
      clear: () => selectAntennas([]),
      chip: (group) => ({
        badge: antennaNumber(group), text: `${group.name} · ${group.rows.length} registros`,
        label: `Quitar la antena ${antennaNumber(group)} de la selección`, remove: () => showAntenna(group),
      }),
    });
  }
  // Share of all the records of the file, as in the row "Copiar" puts on the clipboard.
  const usage = (group) => `${(data.rows.length ? group.rows.length / data.rows.length * 100 : 0).toFixed(1)}%`;
  function antennaSummary() {
    const fragment = document.createDocumentFragment();
    // Only antennas that can be placed on the map are listed; the rest are counted in a note.
    const groups = summarizeAntennas(data);
    const located = groups.filter((group) => group.points.length);
    antennaGroups = located;
    const hiddenRecords = groups.reduce((sum, group) => sum + (group.points.length ? 0 : group.rows.length), 0);
    for (const group of located) {
      const item = document.createElement('div');
      item.className = 'planning-antenna-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planning-antenna';
      const title = document.createElement('strong');
      // The antenna number shows only while the antenna is selected (see planeacion-geografica.css).
      const number = document.createElement('span');
      number.className = 'planning-overnight-rank planning-antenna-number';
      number.textContent = antennaNumber(group);
      title.append(number, `${group.name} · ${group.rows.length} registros`);
      const location = document.createElement('span');
      location.textContent = `Ubicación: ${group.ubicacion || 'Sin información'} · Lugar: ${group.lugar || 'Sin información'}`;
      const coordinates = document.createElement('span');
      coordinates.textContent = group.coordinates;
      button.append(title, location, coordinates);
      button.dataset.option = antennaOptionId(group);
      button.addEventListener('click', () => showAntenna(group));
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-sm btn-outline-secondary planning-copy';
      copy.textContent = 'Copiar';
      copy.setAttribute('aria-label', `Copiar ${group.name} al portapapeles`);
      copy.addEventListener('click', () => {
        copyAntenna(antennaClipboardText(group, data.rows.length), antennaClipboardHtml(group, data.rows.length))
          .then(() => {
            copy.textContent = 'Copiado';
            setTimeout(() => { copy.textContent = 'Copiar'; }, 1500);
          })
          .catch(() => message('No fue posible copiar la antena al portapapeles. Intenta de nuevo.', true));
      });
      item.append(button, copy);
      fragment.append(item);
    }
    if (!located.length) {
      const empty = document.createElement('p');
      empty.className = 'small mb-0';
      empty.textContent = 'Ninguna antena del archivo tiene coordenadas válidas.';
      fragment.append(empty);
    }
    if (hiddenRecords) {
      const note = document.createElement('p');
      note.className = 'small text-muted mb-0';
      note.textContent = `${hiddenRecords} registros sin coordenadas válidas no se muestran en esta lista.`;
      fragment.append(note);
    }
    byId('planningAntennas').replaceChildren(fragment);
    markOption();
  }
  const formatNight = (night) => night.split('-').reverse().join('/');
  const overnightId = (location) => `pernocta:${location.coordinates}`;
  function showOvernight(location) {
    selectOption({
      id: overnightId(location), label: `Pernocta ${location.name}`, rows: location.rows,
      popup: { lat: location.lat, lng: location.lng, text: `Pernocta: ${location.name} · ${location.nights} noches · ${location.rows.length} registros nocturnos` },
    });
  }
  function overnightSummary() {
    overnightLayer.clearLayers();
    if (!modules.overnight) return;
    const list = byId('planningOvernight');
    const note = (text) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'small mb-0';
      paragraph.textContent = text;
      list.replaceChildren(paragraph);
    };
    if (!data?.hasTimes) return note('El archivo no tiene fecha y hora; no es posible estimar la pernocta.');
    if (![nightStart, nightEnd, nightShare, nightRadius].every((input) => input.reportValidity())) return;
    if (nightStart.value === nightEnd.value) return note('El inicio y el fin de la noche no pueden ser la misma hora.');
    const result = findOvernightLocations(data, {
      start: nightStart.value, end: nightEnd.value, minShare: Number(nightShare.value), radius: Number(nightRadius.value),
      include: inPeriod,
    });
    if (!result.totalNights) {
      return note(`Ningún registro con coordenadas cae entre las ${nightStart.value} y las ${nightEnd.value}${timeFilterActive() ? ' en el periodo elegido' : ''}.`);
    }
    const fragment = document.createDocumentFragment();
    const summary = document.createElement('p');
    summary.className = 'small text-muted mb-0';
    summary.textContent = `${result.nightRecords} registros nocturnos en ${result.totalNights} noches. Se muestran las ubicaciones presentes en al menos el ${nightShare.value}% de las noches.`;
    fragment.append(summary);
    for (const [index, location] of result.locations.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `planning-antenna${index === 0 ? ' planning-overnight-top' : ''}`;
      const title = document.createElement('strong');
      const rank = document.createElement('span');
      rank.className = 'planning-overnight-rank';
      rank.textContent = String(index + 1);
      title.append(rank, `${location.name} · ${location.nights} de ${result.totalNights} noches (${Math.round(location.share)}%)`);
      const place = document.createElement('span');
      place.textContent = `Ubicación: ${location.ubicacion || 'Sin información'} · Lugar: ${location.lugar || 'Sin información'}`;
      const detail = document.createElement('span');
      detail.textContent = `${location.rows.length} registros nocturnos · ${formatNight(location.firstNight)} a ${formatNight(location.lastNight)} · `
        + `Primera de la noche: ${location.settles} · Última de la noche: ${location.wakes}`;
      const coordinates = document.createElement('span');
      coordinates.textContent = location.coordinates;
      button.append(title, place, detail, coordinates);
      button.dataset.option = overnightId(location);
      button.addEventListener('click', () => showOvernight(location));
      fragment.append(button);
      // Numbered pins above the coverage, the most likely one larger and in its own colour.
      L.marker([location.lat, location.lng], {
        icon: L.divIcon({
          className: '', html: `<span class="planning-overnight-marker${index === 0 ? ' is-top' : ''}">${index + 1}</span>`,
          iconSize: index === 0 ? [32, 32] : [26, 26],
        }),
        zIndexOffset: 1000 - index, keyboard: false,
      }).bindTooltip(`Pernocta ${index + 1}: ${location.name} · ${location.nights} noches`)
        .on('click', () => showOvernight(location)).addTo(overnightLayer);
    }
    if (!result.locations.length) {
      const empty = document.createElement('p');
      empty.className = 'small mb-0';
      empty.textContent = 'Ninguna ubicación alcanza el mínimo de noches. Baja el porcentaje para ver más candidatas.';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    markOption();
  }
  let contacts = null;
  for (const name of Object.keys(modules)) applyModule(name);
  function contactSummary() {
    contacts = summarizeContacts(data, inPeriod);
    const fragment = document.createDocumentFragment();
    const note = byId('planningContactsTarget');
    byId('planningContactsExport').disabled = !modules.contacts || !contacts?.contacts.length;
    if (!contacts) {
      note.textContent = 'El archivo no tiene columnas Número A y Número B; no es posible identificar contactos.';
      byId('planningContacts').replaceChildren();
      return;
    }
    const period = timeFilterActive() ? ' en el periodo elegido' : '';
    note.textContent = !contacts.target ? 'No se encontraron números en las columnas A y B.'
      : contacts.detected
        ? `Objetivo detectado: ${contacts.target} (el número más frecuente en A y B${contacts.typed ? `; la línea capturada ${contacts.typed} no aparece en el archivo` : ''}). ${contacts.contacts.length} contactos${period}.`
        : `Objetivo: ${contacts.target}. ${contacts.contacts.length} contactos${period}. Pulsa un contacto para ver en el mapa dónde se comunicó con él.`;
    const total = contacts.contacts.reduce((sum, contact) => sum + contact.total, 0);
    for (const contact of contacts.contacts) {
      const item = document.createElement('div');
      item.className = 'planning-antenna-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planning-antenna';
      const title = document.createElement('strong');
      title.textContent = `${contact.line} · ${contact.total} registros`;
      const direction = document.createElement('span');
      direction.textContent = `Salientes: ${contact.outgoing} · Entrantes: ${contact.incoming}`;
      button.append(title, direction);
      if (contact.first) {
        const range = document.createElement('span');
        range.textContent = `Del ${formatContactTime(contact.first)} al ${formatContactTime(contact.last)}`;
        button.append(range);
      }
      button.dataset.option = `contacto:${contact.line}`;
      button.addEventListener('click', () => selectOption({ id: `contacto:${contact.line}`, label: `Contacto ${contact.line}`, rows: contact.rows }));
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-sm btn-outline-secondary planning-copy';
      copy.textContent = 'Copiar';
      copy.setAttribute('aria-label', `Copiar el contacto ${contact.line} al portapapeles`);
      copy.addEventListener('click', () => {
        const cells = contactCells(contact, total);
        copyAntenna(cells.join('\t'), `<table><tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr></table>`)
          .then(() => {
            copy.textContent = 'Copiado';
            setTimeout(() => { copy.textContent = 'Copiar'; }, 1500);
          })
          .catch(() => message('No fue posible copiar el contacto al portapapeles. Intenta de nuevo.', true));
      });
      item.append(button, copy);
      fragment.append(item);
    }
    if (contacts.target && !contacts.contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'small mb-0';
      empty.textContent = `Ningún registro${period} tiene un contacto del objetivo.`;
      fragment.append(empty);
    }
    if (contacts.withoutContact) {
      const skipped = document.createElement('p');
      skipped.className = 'small text-muted mb-0';
      skipped.textContent = `${contacts.withoutContact} registros sin contacto (datos, servicios o sin número en A o B).`;
      fragment.append(skipped);
    }
    byId('planningContacts').replaceChildren(fragment);
    markOption();
  }
  // Última comunicación: the latest completed call, data session and SMS of the period, each one a single record.
  let lastCommunications = [];
  // "llamada completada", "uso de datos", "mensajería SMS", joined as "llamada completada y mensajería SMS".
  const kindName = (entry) => entry.label[0].toLowerCase() + entry.label.slice(1);
  const kindList = (entries) => {
    const names = entries.map(kindName);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0];
  };
  const lastAntennaText = (entries) => `Antena de última comunicación de ${kindList(entries)}`;
  // As in Frecuencia de antenas, pressing a kind adds it to the selection, or removes it when it was already there.
  function showLast(entry) {
    const current = option?.entries ? [...option.entries] : [];
    const entries = current.some((picked) => picked.kind === entry.kind)
      ? current.filter((picked) => picked.kind !== entry.kind)
      : [...current, entry];
    selectLast(entries, entries.length === 1 && entries[0] === entry);
  }
  function selectLast(entries, withPopup = false) {
    const [first] = entries;
    const point = first && pointsByRow.get(first.row);
    selectOption({
      id: 'ultima:seleccion', ids: new Set(entries.map((entry) => `ultima:${entry.kind}`)), entries,
      label: entries.length ? lastAntennaText(entries) : '', rows: [...new Set(entries.map((entry) => entry.row))],
      popup: withPopup && point ? { lat: point.lat, lng: point.lng, text: `${lastAntennaText([first])} · ${formatContactTime(first.time)} · registro ${first.row}` } : null,
    });
  }
  function renderSelectedLast() {
    const entries = option?.entries || [];
    renderSelectedBox(byId('planningLastSelected'), entries, {
      title: `${entries.length} ${entries.length === 1 ? 'comunicación seleccionada' : 'comunicaciones seleccionadas'}`,
      clear: () => selectLast([]),
      chip: (entry) => ({
        badge: '', text: `${entry.label} · ${formatContactTime(entry.time)}`,
        label: `Quitar ${kindName(entry)} de la selección`, remove: () => showLast(entry),
      }),
    });
  }
  // One pin per antenna, naming every kind whose latest record was there.
  // Pressing a pin of the overview picks its kinds; once picked, it lists the records at that antenna.
  function drawLastPins(entries, onPick = null) {
    const byAntenna = new Map();
    for (const entry of entries) {
      const point = pointsByRow.get(entry.row);
      if (!point) continue;
      const key = coordinateKey(point);
      if (!byAntenna.has(key)) byAntenna.set(key, { point, entries: [] });
      byAntenna.get(key).entries.push(entry);
    }
    for (const { point, entries: here } of byAntenna.values()) {
      routePin(point, lastAntennaText(here),
        `${lastAntennaText(here)}: ${here.map((entry) => `${kindName(entry)} ${formatContactTime(entry.time)}`).join(' · ')}`,
        () => (onPick ? onPick(here) : showCoordinateRecords(point)), 'planning-route-text');
    }
    return new Set(byAntenna.keys());
  }
  function lastSummary() {
    lastCommunications = [];
    const list = byId('planningLast');
    const note = (text) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'small mb-0';
      paragraph.textContent = text;
      list.replaceChildren(paragraph);
    };
    if (!data) return;
    if (!data.hasTimes) return note('El archivo no tiene fecha y hora; no es posible saber cuál fue la última comunicación.');
    const result = findLastCommunications(data, inPeriod);
    const { antenna, location, place } = antennaColumns(data.headers);
    const cell = (row, column) => (column >= 0 ? String(data.rows[row - 1]?.[column] ?? '').trim() : '');
    const period = timeFilterActive() ? ' en el periodo elegido' : '';
    const fragment = document.createDocumentFragment();
    // "Copiar" fills the report table: tipo, emisor, receptor, fecha, hora, duración, ubicación y lugar.
    const target = summarizeContacts(data)?.target || '';
    const reportRow = (entry) => lastCommunicationCells(data, entry.row, result.columns, { label: entry.label, location, place, target });
    const copyButton = (text, ariaLabel, rowsOfCells) => {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-sm btn-outline-secondary planning-copy';
      copy.textContent = text;
      copy.setAttribute('aria-label', ariaLabel);
      copy.addEventListener('click', () => {
        const clip = lastCommunicationClipboard(rowsOfCells());
        copyAntenna(clip.text, clip.html)
          .then(() => {
            copy.textContent = 'Copiado';
            setTimeout(() => { copy.textContent = text; }, 1500);
          })
          .catch(() => message('No fue posible copiar la última comunicación al portapapeles. Intenta de nuevo.', true));
      });
      return copy;
    };
    if (!result.hasType) {
      const warning = document.createElement('p');
      warning.className = 'small text-muted mb-0';
      warning.textContent = 'El archivo no tiene una columna de tipo de comunicación (Tipo, Servicio…); solo se reconocen sesiones de datos por un Número B sin línea.';
      fragment.append(warning);
    }
    // Most recent first, whatever its kind; kinds without records go last.
    const byRecency = [...COMMUNICATION_KINDS].sort((x, y) => (result[y.kind].time || '').localeCompare(result[x.kind].time || ''));
    for (const { kind, label, short } of byRecency) {
      const found = result[kind];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planning-antenna';
      const title = document.createElement('strong');
      if (!found.row) {
        button.disabled = true;
        title.textContent = `${label}: sin registros${period}`;
        button.append(title);
        if (found.count) {
          const detail = document.createElement('span');
          detail.textContent = `${found.count} registros sin fecha y hora legibles.`;
          button.append(detail);
        }
        fragment.append(button);
        continue;
      }
      const entry = { kind, label, short, row: found.row, time: found.time };
      lastCommunications.push(entry);
      const point = pointsByRow.get(found.row);
      const number = point ? numbers.get(coordinateKey(point)) : '';
      const name = cell(found.row, antenna);
      // The file's own type ("MENSAJE SALIENTE", "VOZ ENTRANTE") tells the direction.
      const type = cell(found.row, result.columns.type);
      title.textContent = `${label}${type ? ` (${type})` : ''} · ${formatContactTime(found.time)}`;
      const antennaLine = document.createElement('span');
      antennaLine.textContent = point
        ? `Antena ${number}${name && name !== number ? ` · ${name}` : ''} · Ubicación: ${cell(found.row, location) || 'Sin información'} · Lugar: ${cell(found.row, place) || 'Sin información'}`
        : 'Sin coordenadas válidas para mostrarla en el mapa.';
      const detail = document.createElement('span');
      const { a, b } = result.columns;
      const parties = a >= 0 && b >= 0 ? ` · A: ${cell(found.row, a) || '—'} · B: ${cell(found.row, b) || '—'}` : '';
      detail.textContent = `Registro ${found.row} · ${found.count} en total${period}${parties}`;
      button.append(title, antennaLine, detail);
      if (point) {
        const coordinates = document.createElement('span');
        coordinates.textContent = coordinateKey(point).replace(',', ', ');
        button.append(coordinates);
      }
      button.dataset.option = `ultima:${kind}`;
      button.addEventListener('click', () => showLast(entry));
      const item = document.createElement('div');
      item.className = 'planning-antenna-item';
      item.append(button, copyButton('Copiar', `Copiar ${label} al portapapeles`, () => [reportRow(entry)]));
      fragment.append(item);
    }
    if (lastCommunications.length > 1) {
      const all = copyButton('Copiar todas', 'Copiar todas las últimas comunicaciones al portapapeles',
        () => lastCommunications.map(reportRow));
      all.style.justifySelf = 'start';
      fragment.append(all);
    }
    list.replaceChildren(fragment);
    markOption();
  }
  function showCoordinateRecords(point) {
    coordinateFilter = coordinateKey(point);
    page = 1;
    table();
    byId('planningData').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function fit() {
    const bounds = L.latLngBounds([]);
    const layerBounds = layers.getBounds();
    if (layerBounds.isValid()) bounds.extend(layerBounds);
    // "Solo módulos" may show nothing but the overnight pins.
    if (coverageMode.value === 'modules') overnightLayer.eachLayer((marker) => bounds.extend(marker.getLatLng()));
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
    const palette = paletteById(paletteId).colors;
    const scale = colorMode.value === 'frequency' && points.length
      ? frequencyScale(Math.max(...counts.values()), palette) : null;
    const countOf = (point) => counts.get(coordinateKey(point));
    // The busiest points are drawn last, so their darker colour stays on top where coverages overlap.
    const ordered = [...points].sort((a, b) => countOf(a) - countOf(b));
    const asRange = coverageMode.value === 'range';
    if (coverageMode.value === 'route' || (coverageMode.value === 'modules' && selectionActive)) {
      renderLegend(null);
      // Picked últimas comunicaciones keep their sentence instead of the antenna number.
      finishDraw(points, option?.entries ? drawLastPins(option.entries) : drawRoute(ordered), shouldFit);
      return;
    }
    if (coverageMode.value === 'modules') {
      renderLegend(null);
      finishDraw(points, drawModules(), shouldFit);
      return;
    }
    for (const point of ordered) {
      const bearing = point.azimuth;
      // Without an azimuth there is no direction, but the reach is still known: the antenna gets the circle of its
      // range, as in the Rango mode. In the sector mode its outline is dotted, so it reads as "no direction".
      const asCircle = asRange || bearing === null;
      // Records of the same antenna and azimuth share one coverage; repeating it would only darken it.
      const key = `${point.lat},${point.lng},${asCircle ? 'range' : bearing}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const color = adjustSaturation(scale ? scale.colorFor(countOf(point)) : palette[3], saturation.value);
      const fill = { pane: 'coverageFill', stroke: false, fillColor: color, fillOpacity: 1, interactive: false };
      const dashArray = !asRange && bearing === null ? '1 5'
        : rangeMode.value === 'estimated' && estimates && !isEstimated(point) ? '6 5' : null;
      const line = { pane: 'coverageLine', color, weight: 1.5, fill: false, interactive: false, dashArray };
      if (asCircle) {
        const centre = [point.lat, point.lng];
        L.circle(centre, { ...fill, radius: rangeFor(point) }).addTo(layers);
        L.circle(centre, { ...line, radius: rangeFor(point) }).addTo(layers);
      } else {
        const sector = coverageSector(point.lat, point.lng, bearing, rangeFor(point), Number(beam.value));
        L.polygon(sector, fill).addTo(layers);
        L.polygon(sector, line).addTo(layers);
      }
      // A dark outline keeps every point visible over roads, parks and water.
      L.circleMarker([point.lat, point.lng], {
        radius: MARKER_SIZES[sizeOf(point)] + (selectionActive ? 1 : 0),
        color: '#1f1f1f', weight: sizeOf(point) === 'punto' ? 1 : 1.5, fillColor: color, fillOpacity: 1, interactive: true,
      }).on('click', () => (markerSize.value === 'combinada' ? openSizeMenu(point) : showCoordinateRecords(point))).addTo(layers);
    }
    // Selected antennas carry their number over the coverage, as the pins of "Ruta" do.
    for (const group of option?.groups || []) {
      routePin(group.points[0], antennaNumber(group), `Antena ${antennaNumber(group)} · ${group.name} · ${group.rows.length} registros`,
        () => showCoordinateRecords(group.points[0]));
    }
    if (option?.entries) drawLastPins(option.entries);
    renderLegend(scale);
    finishDraw(points, seen, shouldFit);
  }
  // "Ruta": no coverage, one red pin per antenna with its number above, as in the Ruta KMZ.
  function drawRoute(points) {
    const placed = new Set();
    const records = new Map();
    for (const point of points) records.set(coordinateKey(point), (records.get(coordinateKey(point)) || 0) + 1);
    for (const point of points) {
      const key = coordinateKey(point);
      if (placed.has(key)) continue;
      placed.add(key);
      const number = numbers.get(key) || '';
      routePin(point, number, `Antena ${number} · ${records.get(key)} registros`, () => showCoordinateRecords(point));
    }
    return placed;
  }
  // A red pin with a text above it: the antenna number in "Ruta", its share of use in "Solo módulos".
  function routePin(point, text, tooltip, onClick, labelClass = '') {
    const label = document.createElement('span');
    label.className = `planning-route-number ${labelClass}`.trim();
    label.textContent = text;
    const icon = document.createElement('div');
    icon.className = 'planning-route-marker';
    icon.innerHTML = ROUTE_PIN;
    // The label keeps its size; only the pin under it grows or shrinks.
    const scale = PIN_SCALES[sizeOf(point)];
    const pinWidth = Math.round(28 * scale);
    const pinHeight = Math.round(40 * scale);
    const svg = icon.querySelector('svg');
    svg.setAttribute('width', pinWidth);
    svg.setAttribute('height', pinHeight);
    const width = Math.max(40, pinWidth + 12);
    const height = pinHeight + 20;
    icon.style.width = `${width}px`;
    icon.style.height = `${height}px`;
    icon.prepend(label);
    L.marker([point.lat, point.lng], {
      icon: L.divIcon({ className: '', html: icon, iconSize: [width, height], iconAnchor: [width / 2, height], tooltipAnchor: [0, -(pinHeight + 6)] }),
      keyboard: false, title: tooltip,
    }).bindTooltip(tooltip).on('click', () => (markerSize.value === 'combinada' ? openSizeMenu(point, onClick) : onClick())).addTo(layers);
  }
  // "Solo módulos": only what the modules switched on put on the map. Pernocta keeps its numbered pins (its own
  // layer); Frecuencia de antenas adds one pin per antenna with its share of use. Contactos adds nothing until a
  // contact is picked, because a contact has no single location.
  function drawModules() {
    const placed = new Set();
    if (modules.antennas) {
      for (const group of antennaGroups) {
        placed.add(coordinateKey(group.points[0]));
        routePin(group.points[0], usage(group), `${group.name} · ${group.rows.length} registros (${usage(group)} del archivo)`, () => showAntenna(group));
      }
    }
    if (modules.last) for (const key of drawLastPins(lastCommunications, (here) => selectLast(here, here.length === 1))) placed.add(key);
    return placed;
  }
  function finishDraw(points, seen, shouldFit) {
    byId('planningFit').disabled = !data.points.length;
    byId('planningExportSelection').disabled = !selectionActive || selectedRows.size === 0;
    const period = timeFilterActive() ? ` en el periodo elegido` : '';
    if (coverageMode.value === 'modules' && !selectionActive) {
      const shown = [
        modules.overnight && data.hasTimes ? 'Pernocta' : '',
        modules.antennas ? `Frecuencia de antenas (${antennaGroups.length} antenas, % de uso sobre ${data.rows.length} registros del archivo)` : '',
        modules.last && lastCommunications.length ? 'Última comunicación' : '',
      ].filter(Boolean);
      message(shown.length
        ? `Solo módulos: ${shown.join(', ')}. Pulsa una opción de un módulo para ver sus registros.`
        : 'Solo módulos: activa Pernocta, Frecuencia de antenas o Última comunicación para mostrar sus antenas, o pulsa un contacto.');
    } else if (coverageMode.value === 'route' || coverageMode.value === 'modules') {
      message(selectionActive
        ? `${selectedRows.size} registros seleccionados en ${seen.size} antenas. Pulsa un pin para ver sus registros.`
        : `${points.length} de ${data.rows.length} registros con coordenadas${period} en ${seen.size} antenas. ${data.omitted} registros sin coordenadas válidas.`);
    } else if (selectionActive && selectedRows.size === 1) {
      const selectedRow = [...selectedRows][0];
      const point = pointsByRow.get(selectedRow);
      const estimate = estimateFor(point);
      const reach = estimate ? describeEstimate(estimate) : `${radius.value} m`;
      message(point.azimuth === null
        ? `Registro ${selectedRow}: antena sin azimut en el archivo; se muestra el rango de ${reach} sin dirección.`
        : coverageMode.value === 'range'
          ? `Registro ${selectedRow}: solo rango de ${reach}, sin dirección.`
          : `Registro ${selectedRow}: azimut ${point.azimuth}°, apertura ${beam.value}°. Alcance: ${reach}.`);
    } else if (selectionActive) {
      message(`${selectedRows.size} registros seleccionados; ${seen.size} ubicaciones y orientaciones representadas. ${selectedRows.size ? `Alcance: ${reachSummary()}. Los registros sin azimut muestran su rango sin dirección (contorno de puntos).` : 'Selecciona registros o usa “Ver todas las antenas”.'}`);
    } else {
      message(`${points.length} de ${data.rows.length} registros con coordenadas${period}; ${seen.size} ubicaciones y orientaciones representadas. ${data.omitted} registros sin coordenadas válidas. ${data.missingAzimuth} registros sin azimut válido muestran su rango sin dirección (contorno de puntos). Alcance: ${reachSummary()}.`);
    }
    if (shouldFit) fit();
  }
  function table() {
    const visible = [];
    for (const [offset, row] of data.rows.entries()) {
      const rowNumber = offset + 1;
      if (option && !option.rows.has(rowNumber)) continue;
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
      option ? option.label : '',
      coordinateFilter === null ? '' : `Coordenadas: ${coordinateFilter}`,
      timeFilterActive() ? 'Periodo filtrado' : '',
      search.value.trim() ? `Búsqueda: “${search.value.trim()}”` : '',
    ].filter(Boolean).join(' · ');
    byId('planningFile').textContent = `${data.name}${contacts?.target ? ` · Objetivo ${contacts.target}` : ''} · ${visible.length} de ${data.rows.length} registros${filters ? ` · ${filters}` : ''}`;
    byId('planningClearFilter').hidden = coordinateFilter === null && !option;
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
  function load(result) {
    data = { times: {}, hasTimes: false, ...result };
    antennaSizes = new Map();
    clearSelection();
    page = 1;
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
    numbers = antennaNumbers(data);
    antennaSummary();
    overnightSummary();
    contactSummary();
    lastSummary();
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
    estimates = null;
    estimateRequest++;
    draw({ fit: true });
    requestEstimates();
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
    } catch (error) {
      message(error.message || 'No fue posible conectar con el servidor.', true);
    } finally {
      byId('planningSubmit').disabled = false;
    }
  });
  for (const input of [nightStart, nightEnd, nightShare, nightRadius]) {
    input.addEventListener('change', () => { if (data) overnightSummary(); });
  }
  byId('planningOvernightSettings').addEventListener('submit', (event) => event.preventDefault());
  coverageMode.addEventListener('change', () => draw());
  beam.addEventListener('change', () => draw());
  radius.addEventListener('change', () => draw());
  rangeMode.addEventListener('change', () => {
    operator.disabled = rangeMode.value !== 'estimated';
    if (rangeMode.value === 'estimated' && !estimates) requestEstimates();
    else draw();
  });
  operator.addEventListener('change', () => {
    estimates = null;
    requestEstimates();
  });
  colorMode.addEventListener('change', () => draw());
  markerSize.addEventListener('change', () => {
    saveStyle();
    map.closePopup();
    draw();
  });
  // Opacity only changes the fill pane, so it needs no redraw.
  opacity.addEventListener('input', () => { applyStyleValues(); saveStyle(); });
  let styleFrame = 0;
  saturation.addEventListener('input', () => {
    applyStyleValues();
    saveStyle();
    // The slider fires many events while dragging; recolour at most once per frame.
    cancelAnimationFrame(styleFrame);
    styleFrame = requestAnimationFrame(() => { renderPalettes(); draw(); });
  });
  paletteList.addEventListener('change', (event) => {
    if (event.target.name !== 'planningPalette') return;
    paletteId = event.target.value;
    saveStyle();
    draw();
  });
  byId('planningStyleReset').addEventListener('click', () => {
    paletteId = STYLE_DEFAULTS.palette;
    saturation.value = STYLE_DEFAULTS.saturation;
    opacity.value = STYLE_DEFAULTS.opacity;
    markerSize.value = STYLE_DEFAULTS.markerSize;
    antennaSizes = new Map();
    applyStyleValues();
    saveStyle();
    renderPalettes();
    draw();
  });
  const periodChanged = () => {
    if (!data) return;
    if (from.value && to.value && from.value > to.value) {
      message('La fecha inicial no puede ser posterior a la final.', true);
      return;
    }
    page = 1;
    contactSummary();
    lastSummary();
    table();
    draw();
    overnightSummary();
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
    page = 1;
    if (!option) {
      coordinateFilter = null;
      table();
      return;
    }
    clearSelection();
    table();
    draw({ fit: true });
  });
  byId('planningFit').addEventListener('click', () => {
    if (!data || !radius.reportValidity()) return;
    clearSelection();
    table();
    draw({ fit: true });
  });
  byId('planningExport').addEventListener('click', () => {
    if (data) download(`Planeacion-${baseName(data.name)}.csv`, data.csv);
  });
  byId('planningContactsExport').addEventListener('click', () => {
    if (contacts?.contacts.length) download(`Contactos-${safeLine(contacts.target)}.csv`, contactsCsv(contacts));
  });
  byId('planningExportSelection').addEventListener('click', () => {
    if (!data || !selectedRows.size) return;
    download(`Planeacion-${baseName(data.name)}-seleccion.csv`, selectionCsv(data.headers, data.rows, selectedRows));
  });
}
