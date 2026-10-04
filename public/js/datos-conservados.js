(() => {
  const tipo = document.getElementById('tipoRegistro');
  const form = document.getElementById('datosConservadosForm');
  const ciudad = document.getElementById('dc_ciudad');
  const status = document.getElementById('dc_ciudadStatus');
  const retry = document.getElementById('dc_retry');
  const cantidad = document.getElementById('dc_lineas');
  const lineas = document.getElementById('dc_lineasDescritas');
  const button = document.getElementById('dc_registrar');
  const resultado = document.getElementById('dc_resultado');
  let cargadas = false, cargando = false, guardando = false;

  function actualizarLineas() {
    const count = Number(cantidad.value);
    if (!Number.isInteger(count) || count < 0 || count > 1000) return;
    while (lineas.children.length < count) {
      const index = lineas.children.length + 1;
      const group = document.createElement('div');
      group.className = 'col-12 col-sm-6';
      const label = document.createElement('label');
      label.className = 'form-label small mb-1';
      label.htmlFor = `dc_linea_${index}`;
      label.textContent = `Línea ${index}`;
      const input = document.createElement('input');
      Object.assign(input, { type: 'tel', id: label.htmlFor, name: 'lineas_descritas[]', className: 'form-control form-control-sm', maxLength: 50 });
      group.append(label, input);
      lineas.append(group);
    }
    Array.from(lineas.children).forEach((group, index) => {
      group.hidden = index >= count;
      group.querySelector('input').disabled = form.hidden || group.hidden;
    });
  }

  async function cargarCiudades() {
    if (cargadas || cargando) return;
    cargando = true;
    retry.hidden = true;
    status.textContent = 'Cargando cabeceras municipales…';
    try {
      const response = await fetch('/api/localidades?estado=Sonora&cabeceras=1', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.localidades) || !data.localidades.length) throw new Error();
      ciudad.replaceChildren(new Option('Seleccionar ciudad', ''));
      data.localidades.forEach(name => ciudad.add(new Option(name, name)));
      cargadas = true;
      ciudad.disabled = form.hidden;
      status.textContent = 'Solo cabeceras municipales de Sonora.';
    } catch {
      status.textContent = 'No fue posible cargar las ciudades. Reintenta la consulta.';
      retry.hidden = false;
    } finally { cargando = false; }
  }

  function actualizarTipo() {
    const active = tipo.value === 'Datos Conservados';
    form.hidden = !active;
    form.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = !active; });
    ciudad.disabled = !active || !cargadas;
    actualizarLineas();
    if (active) cargarCiudades();
  }
  form.addEventListener('invalid', (event) => {
    const section = event.target.closest('details');
    if (section) section.open = true;
  }, true);
  cantidad.addEventListener('input', actualizarLineas);
  retry.addEventListener('click', cargarCiudades);
  tipo.addEventListener('change', actualizarTipo);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (guardando || form.hidden || !form.reportValidity()) return;
    resultado.className = 'alert alert-danger mt-3 mb-0';
    resultado.hidden = false;
    const values = new FormData(form);
    const datos = Object.fromEntries(values);
    datos.lineas_descritas = values.getAll('lineas_descritas[]');
    delete datos['lineas_descritas[]'];
    guardando = true;
    button.disabled = true;
    tipo.disabled = true;
    resultado.hidden = true;
    button.textContent = 'Registrando…';
    try {
      const response = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(datos) });
      if (response.redirected) throw new Error('Vuelve a iniciar sesión para registrar.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No fue posible guardar.');
      form.reset();
      lineas.replaceChildren();
      actualizarTipo();
      form.querySelectorAll('details').forEach((section, index) => { section.open = index === 0; });
      resultado.className = 'alert alert-success mt-3 mb-0';
      resultado.textContent = `${data.message} Folio: ${data.id}.`;
      document.dispatchEvent(new Event('identificacion-registrada'));
    } catch (error) {
      resultado.textContent = error.message || 'No fue posible guardar. Intenta nuevamente.';
    } finally {
      guardando = false;
      button.disabled = false;
      tipo.disabled = false;
      button.textContent = 'Registrar datos conservados';
      resultado.hidden = false;
    }
  });
  actualizarTipo();
})();
