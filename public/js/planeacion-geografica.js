import { coverageSector, adjustSaturation } from './planeacion-geometry.js?v=7';
import { COVERAGE_PALETTES, DEFAULT_PALETTE, paletteById } from './planeacion-paletas.js?v=1';
import {
  summarizeAntennas, antennaClipboardText, antennaClipboardHtml, rowMatches, frequencyScale, selectionCsv, antennaNumbers,
} from './planeacion-antenas.js?v=10';
import { findOvernightLocations } from './planeacion-pernocta.js?v=3';
import { summarizeContacts, contactCells, contactsCsv, formatContactTime } from './planeacion-contactos.js?v=1';

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
  const STYLE_DEFAULTS = { palette: DEFAULT_PALETTE, saturation: '100', opacity: '30' };
  let paletteId = DEFAULT_PALETTE;
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}');
    if (typeof saved.palette === 'string') paletteId = paletteById(saved.palette).id;
    if (typeof saved.saturation === 'string') saturation.value = saved.saturation;
    if (typeof saved.opacity === 'string') opacity.value = saved.opacity;
  } catch { /* Without storage the defaults apply. */ }
  function saveStyle() {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify({ palette: paletteId, saturation: saturation.value, opacity: opacity.value }));
    } catch { /* Storage may be disabled; the choice lasts until reload. */ }
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
  let option = null;
  function markOption() {
    for (const button of document.querySelectorAll('[data-option]')) {
      const active = button.dataset.option === option?.id;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    }
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
  function selectOption({ id, label, rows, popup = null }) {
    if (!radius.reportValidity()) return;
    const again = option?.id === id;
    clearSelection();
    page = 1;
    if (again) {
      table();
      draw({ fit: true });
      return;
    }
    option = { id, label, rows: new Set(rows) };
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

  // Pernocta, Frecuencia de antenas and Contactos frecuentes each have a switch that turns the whole module on or off.
  // Off, the module is hidden and its pins leave the map. The choice is remembered in this browser only.
  const MODULES_KEY = 'planeacion-geografica-modulos';
  const MODULE_PREFIX = { overnight: 'pernocta:', antennas: 'antena:', contacts: 'contacto:' };
  const modules = { overnight: true, antennas: true, contacts: true };
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
    if (coverageMode.value === 'modules') draw({ fit: true });
  }
  for (const name of Object.keys(modules)) {
    document.querySelector(`input[data-module="${name}"]`).addEventListener('change', (event) => setModule(name, event.target.checked));
  }

  const antennaOptionId = (group) => `antena:${group.name}|${group.coordinates}`;
  function showAntenna(group) {
    selectOption({
      id: antennaOptionId(group), label: `Antena ${group.name}`, rows: group.rows,
      popup: { lat: group.points[0].lat, lng: group.points[0].lng, text: `${group.name} · ${group.ubicacion} · ${group.lugar} · ${group.rows.length} registros` },
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
      title.textContent = `${group.name} · ${group.rows.length} registros`;
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
      finishDraw(points, drawRoute(ordered), shouldFit);
      return;
    }
    if (coverageMode.value === 'modules') {
      renderLegend(null);
      finishDraw(points, drawModules(), shouldFit);
      return;
    }
    for (const point of ordered) {
      const bearing = point.azimuth;
      // Records of the same antenna and azimuth share one coverage; repeating it would only darken it.
      const key = `${point.lat},${point.lng},${asRange && bearing !== null ? 'range' : bearing}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const color = adjustSaturation(scale ? scale.colorFor(countOf(point)) : palette[3], saturation.value);
      if (bearing !== null) {
        const fill = { pane: 'coverageFill', stroke: false, fillColor: color, fillOpacity: 1, interactive: false };
        const line = { pane: 'coverageLine', color, weight: 1.5, fill: false, interactive: false };
        if (asRange) {
          const centre = [point.lat, point.lng];
          L.circle(centre, { ...fill, radius: Number(radius.value) }).addTo(layers);
          L.circle(centre, { ...line, radius: Number(radius.value) }).addTo(layers);
        } else {
          const sector = coverageSector(point.lat, point.lng, bearing, Number(radius.value), Number(beam.value));
          L.polygon(sector, fill).addTo(layers);
          L.polygon(sector, line).addTo(layers);
        }
      }
      // A dark outline keeps every point visible over roads, parks and water.
      L.circleMarker([point.lat, point.lng], {
        radius: selectionActive ? 7 : 6, color: '#1f1f1f', weight: 1.5, fillColor: color, fillOpacity: 1, interactive: true,
      }).on('click', () => showCoordinateRecords(point)).addTo(layers);
    }
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
  function routePin(point, text, tooltip, onClick) {
    const label = document.createElement('span');
    label.className = 'planning-route-number';
    label.textContent = text;
    const icon = document.createElement('div');
    icon.className = 'planning-route-marker';
    icon.innerHTML = ROUTE_PIN;
    icon.prepend(label);
    L.marker([point.lat, point.lng], {
      icon: L.divIcon({ className: '', html: icon, iconSize: [40, 60], iconAnchor: [20, 60], tooltipAnchor: [0, -46] }),
      keyboard: false, title: tooltip,
    }).bindTooltip(tooltip).on('click', onClick).addTo(layers);
  }
  // "Solo módulos": only what the modules switched on put on the map. Pernocta keeps its numbered pins (its own
  // layer); Frecuencia de antenas adds one pin per antenna with its share of use. Contactos adds nothing until a
  // contact is picked, because a contact has no single location.
  function drawModules() {
    const placed = new Set();
    if (!modules.antennas) return placed;
    for (const group of antennaGroups) {
      placed.add(coordinateKey(group.points[0]));
      routePin(group.points[0], usage(group), `${group.name} · ${group.rows.length} registros (${usage(group)} del archivo)`, () => showAntenna(group));
    }
    return placed;
  }
  function finishDraw(points, seen, shouldFit) {
    byId('planningFit').disabled = !data.points.length;
    byId('planningExportSelection').disabled = !selectionActive || selectedRows.size === 0;
    const period = timeFilterActive() ? ` en el periodo elegido` : '';
    if (coverageMode.value === 'modules' && !selectionActive) {
      const shown = [
        modules.overnight && data.hasTimes ? 'Pernocta' : '',
        modules.antennas ? `Frecuencia de antenas (${seen.size} antenas, % de uso sobre ${data.rows.length} registros del archivo)` : '',
      ].filter(Boolean);
      message(shown.length
        ? `Solo módulos: ${shown.join(' y ')}. Pulsa una opción de un módulo para ver sus registros.`
        : 'Solo módulos: activa Pernocta o Frecuencia de antenas para mostrar sus antenas, o pulsa un contacto.');
    } else if (coverageMode.value === 'route' || coverageMode.value === 'modules') {
      message(selectionActive
        ? `${selectedRows.size} registros seleccionados en ${seen.size} antenas. Pulsa un pin para ver sus registros.`
        : `${points.length} de ${data.rows.length} registros con coordenadas${period} en ${seen.size} antenas. ${data.omitted} registros sin coordenadas válidas.`);
    } else if (selectionActive && selectedRows.size === 1) {
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
  colorMode.addEventListener('change', () => draw());
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
