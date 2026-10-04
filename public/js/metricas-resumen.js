(() => {
  const form = document.getElementById('metricasFiltro');
  const inicio = document.getElementById('metricasInicio');
  const fin = document.getElementById('metricasFin');
  const button = document.getElementById('consultarMetricas');
  const status = document.getElementById('metricasEstado');
  const resumen = document.getElementById('metricasResumen');
  const total = document.getElementById('metricasTotal');
  const tipos = document.getElementById('metricasTipos');
  const dona = document.getElementById('metricasDona');
  const leyenda = document.getElementById('metricasLeyenda');
  const colores = ['#5b963e', '#e9a25b', '#398392', '#547fba', '#9a6ab0', '#cc7081', '#a49250'];
  const ordenTipos = Array.from(document.getElementById('filtroTipo').options).map(option => option.value).filter(Boolean);
  const today = new Date();
  const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  inicio.value = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
  fin.value = formatDate(today);
  let request = 0;

  async function consultar() {
    const current = ++request;
    fin.setCustomValidity(inicio.value > fin.value ? 'La fecha final debe ser igual o posterior al inicio.' : '');
    if (!form.reportValidity()) return;
    button.disabled = true;
    resumen.hidden = true;
    status.textContent = 'Consultando métricas…';
    try {
      const response = await fetch(`/metricas/resumen?${new URLSearchParams(new FormData(form))}`, { headers: { Accept: 'application/json' } });
      if (response.redirected) throw new Error('Vuelve a iniciar sesión para consultar las métricas.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No fue posible consultar las métricas.');
      if (current !== request) return;
      total.textContent = data.total.toLocaleString('es-MX');
      tipos.replaceChildren();
      leyenda.replaceChildren();
      const maximo = Math.max(1, ...data.tipos.map(item => item.registros));
      const segmentos = [];
      let acumulado = 0;
      data.tipos.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        const label = document.createElement('span');
        label.className = 'bar-label';
        label.textContent = item.tipo;
        const value = document.createElement('span');
        value.className = 'bar-number';
        value.textContent = item.registros.toLocaleString('es-MX');
        const track = document.createElement('div');
        track.className = 'bar-track';
        track.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('div');
        bar.className = 'bar-fill';
        bar.style.width = `${item.registros / maximo * 100}%`;
        track.append(bar);
        row.append(label, track, value);
        tipos.append(row);
        const color = colores[Math.max(0, ordenTipos.indexOf(item.tipo)) % colores.length];
        const porcentaje = data.total ? item.registros / data.total * 100 : 0;
        if (porcentaje > 0) segmentos.push(`${color} ${acumulado}% ${acumulado + porcentaje}%`);
        acumulado += porcentaje;
        const entry = document.createElement('div');
        entry.className = 'legend-item';
        const dot = document.createElement('span');
        dot.className = 'legend-dot';
        dot.style.backgroundColor = color;
        dot.setAttribute('aria-hidden', 'true');
        const nombre = document.createElement('span');
        nombre.textContent = item.tipo;
        const numero = document.createElement('strong');
        numero.textContent = `${value.textContent} (${porcentaje.toLocaleString('es-MX', { maximumFractionDigits: 1 })}%)`;
        entry.append(dot, nombre, numero);
        leyenda.append(entry);
      });
      dona.style.background = segmentos.length ? `conic-gradient(${segmentos.join(', ')})` : '#edf3f5';
      dona.setAttribute('aria-label', data.total ? data.tipos.map(item => `${item.tipo}: ${item.registros}`).join('; ') : 'Sin registros para los filtros seleccionados');
      document.getElementById('metricasGraficaVacia').hidden = data.total !== 0;
      const labels = { tipo: 'Tipo', ciudad: 'Ciudad', agencia: 'Agencia', delito: 'Delito', estatus: 'Estatus', nuc: 'NUC', enviado_a: 'Enviado a', medio: 'Medio' };
      const activos = Object.entries(data.filtros || {}).filter(([, value]) => value).map(([key, value]) => `${labels[key]}: ${value}`);
      status.textContent = `Periodo: ${data.inicio} al ${data.fin}. ${activos.length ? activos.join(' · ') : 'Sin filtros adicionales.'}${data.total ? '' : ' No hay registros con estos criterios.'}`;
      resumen.hidden = false;
    } catch (error) {
      if (current === request) status.textContent = error.message;
    } finally {
      if (current === request) button.disabled = false;
    }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); consultar(); });
  form.addEventListener('input', () => {
    request += 1;
    fin.setCustomValidity('');
    button.disabled = false;
    resumen.hidden = true;
    status.textContent = 'Consulta las métricas para actualizar el periodo.';
  });
  document.addEventListener('identificacion-registrada', consultar);
  document.getElementById('limpiarFiltrosMetricas').addEventListener('click', () => {
    form.querySelectorAll('[name]').forEach(control => {
      if (!['inicio', 'fin'].includes(control.name)) control.value = '';
    });
    consultar();
  });
  const ciudad = document.getElementById('filtroCiudad');
  const ciudadEstado = document.getElementById('filtroCiudadEstado');
  const retry = document.getElementById('filtroCiudadReintentar');
  async function cargarCiudades() {
    ciudadEstado.textContent = 'Cargando ciudades…';
    retry.hidden = true;
    try {
      const response = await fetch('/api/localidades?estado=Sonora&cabeceras=1', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.localidades) || !data.localidades.length) throw new Error();
      ciudad.replaceChildren(new Option('Todas las ciudades', ''));
      data.localidades.forEach(value => ciudad.add(new Option(value, value)));
      ciudad.disabled = false;
      ciudadEstado.textContent = '';
    } catch {
      ciudadEstado.textContent = 'No fue posible cargar las ciudades.';
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', cargarCiudades);
  cargarCiudades();
  consultar();
})();
