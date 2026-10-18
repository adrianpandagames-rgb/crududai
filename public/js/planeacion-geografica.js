import { coverageSector } from './planeacion-geometry.js';
import { summarizeAntennas } from './planeacion-antenas.js';

const byId = (id) => document.getElementById(id);
const status = byId('planningStatus');
function message(text, error = false) {
  status.textContent = text;
  status.className = 'alert ' + (error ? 'alert-danger' : 'alert-info');
}
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
  const layers = L.featureGroup().addTo(map);
  let data = null;
  const selectedRows = new Set();
  let selectionActive = false;
  let pointsByRow = new Map();
  let coordinateFilter = null;
  const coordinateKey = (point) => point ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : null;
  function antennaSummary() {
    const fragment = document.createDocumentFragment();
    for (const group of summarizeAntennas(data)) {
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
        table();
        draw();
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
      fragment.append(button);
    }
    byId('planningAntennas').replaceChildren(fragment);
  }
  function showCoordinateRecords(point) {
    coordinateFilter = coordinateKey(point);
    table();
    byId('planningData').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const coverageMode = byId('planningCoverageMode');
  const radius = byId('planningRadius');
  function fit() {
    const bounds = layers.getBounds();
    if (bounds.isValid()) {
      // A second fit during an active Leaflet zoom can retain the first bounds.
      map.stop();
      map.invalidateSize({ pan: false });
      map.fitBounds(bounds, { padding: [25, 25], maxZoom: 17, animate: false });
    }
  }
  function draw() {
    if (!data || !radius.reportValidity()) return;
    layers.clearLayers();
    const seen = new Set();
    const points = selectionActive ? [...selectedRows].map((row) => pointsByRow.get(row)) : data.points;
    const selectionColors = ['#087cf0', '#e07800', '#8a35c9', '#168449', '#cf3555', '#008b98'];
    for (const [index, point] of points.entries()) {
      const bearing = point.azimuth;
      const key = `${point.lat},${point.lng},${coverageMode.value === 'range' && bearing !== null ? 'range' : bearing}`;
      if (!selectionActive && seen.has(key)) continue;
      seen.add(key);
      const color = selectionActive ? selectionColors[index % selectionColors.length] : '#087cf0';
      if (bearing !== null) {
        const style = { color, weight: 1.5, fillColor: color, fillOpacity: 0.22, interactive: false };
        if (coverageMode.value === 'range') {
          L.circle([point.lat, point.lng], { ...style, radius: Number(radius.value) }).addTo(layers);
        } else {
          L.polygon(coverageSector(point.lat, point.lng, bearing, Number(radius.value)), style).addTo(layers);
        }
      }
      L.circleMarker([point.lat, point.lng], {
        radius: selectionActive ? 6 : 5, color, weight: 1, fillColor: color, fillOpacity: 1, interactive: true,
      }).on('click', () => showCoordinateRecords(point)).addTo(layers);
    }
    byId('planningFit').disabled = !data.points.length;
    if (selectionActive && selectedRows.size === 1) {
      const selectedRow = [...selectedRows][0];
      const point = pointsByRow.get(selectedRow);
      message(point.azimuth === null
        ? `Registro ${selectedRow}: antena sin azimut en el archivo; se muestra únicamente su ubicación.`
        : coverageMode.value === 'range'
          ? `Registro ${selectedRow}: solo rango de ${radius.value} m, sin dirección.`
          : `Registro ${selectedRow}: azimut ${point.azimuth}°. Alcance: ${radius.value} m.`);
    } else if (selectionActive) {
      message(`${selectedRows.size} registros seleccionados; ${seen.size} ubicaciones y orientaciones representadas. ${selectedRows.size ? `Alcance: ${radius.value} m. Los registros sin azimut muestran únicamente la antena.` : 'Selecciona registros o usa “Ver todas las antenas”.'}`);
    } else {
      message(`${data.rows.length} registros; ${seen.size} ubicaciones y orientaciones representadas. ${data.omitted} registros sin coordenadas válidas. ${data.missingAzimuth} registros sin azimut válido muestran únicamente la antena.`);
    }
    fit();
  }
  function table() {
    const body = byId('planningRows');
    const fragment = document.createDocumentFragment();
    let visibleRows = 0;
    for (const [offset, row] of data.rows.entries()) {
      const rowNumber = offset + 1;
      if (coordinateFilter !== null && coordinateKey(pointsByRow.get(rowNumber)) !== coordinateFilter) continue;
      visibleRows++;
      const tr = document.createElement('tr');
      tr.dataset.row = String(rowNumber);
      tr.classList.add('planning-record');
      tr.classList.toggle('planning-record-selected', selectedRows.has(rowNumber));
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', `Seleccionar antena del registro ${rowNumber}`);
      tr.setAttribute('aria-pressed', String(selectedRows.has(rowNumber)));
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
        draw();
      };
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
        select();
        checkbox.checked = selectedRows.has(rowNumber);
      });
      tr.addEventListener('click', select);
      tr.addEventListener('keydown', (event) => {
        if (event.target === tr && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          select();
        }
      });
      for (let column = 0; column < data.headers.length; column++) {
        const td = document.createElement('td');
        td.textContent = row[column] ?? '';
        tr.append(td);
      }
      fragment.append(tr);
    }
    body.replaceChildren(fragment);
    byId('planningFile').textContent = `${data.name} · Línea ${data.line} · ${visibleRows} de ${data.rows.length} registros${coordinateFilter === null ? '' : ` · Coordenadas: ${coordinateFilter}`}`;
    byId('planningClearFilter').hidden = coordinateFilter === null;
  }
  function highlightSelection() {
    const body = byId('planningRows');
    for (const previous of body.querySelectorAll('.planning-record-selected')) {
      previous.classList.remove('planning-record-selected');
      previous.setAttribute('aria-pressed', 'false');
      previous.querySelector('input[type="checkbox"]').checked = false;
    }
    for (const selectedRow of selectedRows) {
      const current = body.querySelector(`[data-row="${selectedRow}"]`);
      current?.classList.add('planning-record-selected');
      current?.setAttribute('aria-pressed', 'true');
      if (current) current.querySelector('input[type="checkbox"]').checked = true;
    }
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
      if (response.redirected) {
        message('La sesión terminó o no tienes acceso. Inicia sesión como administrador.', true);
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No fue posible importar el archivo.');
      data = result;
      selectedRows.clear();
      selectionActive = false;
      coordinateFilter = null;
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
      byId('planningFile').textContent = `${data.name} · Línea ${data.line} · ${data.rows.length} registros`;
      map.invalidateSize({ pan: false });
      byId('planningExport').disabled = false;
      table();
      draw();
    } catch (error) {
      message(error.message || 'No fue posible conectar con el servidor.', true);
    } finally {
      byId('planningSubmit').disabled = false;
    }
  });
  coverageMode.addEventListener('change', draw);
  radius.addEventListener('change', draw);
  byId('planningClearFilter').addEventListener('click', () => {
    if (!data) return;
    coordinateFilter = null;
    table();
  });
  byId('planningFit').addEventListener('click', () => {
    if (!data || !radius.reportValidity()) return;
    selectedRows.clear();
    selectionActive = false;
    coordinateFilter = null;
    table();
    draw();
  });
  byId('planningExport').addEventListener('click', () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Planeacion-${data.line.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
