import { coverageSector } from './planeacion-geometry.js?v=6';
import {
  summarizeAntennas, antennaClipboardText, antennaClipboardHtml, rowMatches, frequencyScale, selectionCsv,
} from './planeacion-antenas.js?v=8';
import { findOvernightLocations } from './planeacion-pernocta.js?v=1';
import { summarizeContacts, contactCells, contactsCsv, formatContactTime } from './planeacion-contactos.js?v=1';

const byId = (id) => document.getElementById(id);
const status = byId('planningStatus');
const PAGE_SIZE = 200;
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
  const overnightLayer = L.layerGroup().addTo(map);
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
  const nightStart = byId('planningNightStart');
  const nightEnd = byId('planningNightEnd');
  const nightShare = byId('planningNightShare');
  const nightRadius = byId('planningNightRadius');

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

  function antennaSummary() {
    const fragment = document.createDocumentFragment();
    // Only antennas that can be placed on the map are listed; the rest are counted in a note.
    const groups = summarizeAntennas(data);
    const located = groups.filter((group) => group.points.length);
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
      const antennaId = `antena:${group.name}|${group.coordinates}`;
      button.dataset.option = antennaId;
      button.addEventListener('click', () => selectOption({
        id: antennaId, label: `Antena ${group.name}`, rows: group.rows,
        popup: { lat: group.points[0].lat, lng: group.points[0].lng, text: `${group.name} · ${group.ubicacion} · ${group.lugar} · ${group.rows.length} registros` },
      }));
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
  function contactSummary() {
    contacts = summarizeContacts(data, inPeriod);
    const fragment = document.createDocumentFragment();
    const note = byId('planningContactsTarget');
    byId('planningContactsExport').disabled = !contacts?.contacts.length;
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
