(() => {
  const tipo = document.getElementById('tipoRegistro');
  const fields = document.getElementById('identificacionLineaFields');
  const ciudad = document.getElementById('ciudad');
  const status = document.getElementById('ciudadStatus');
  const retry = document.getElementById('reintentarCiudades');
  const count = document.getElementById('lineasCount');
  const container = document.getElementById('lineasDescritasContainer');
  const form = document.getElementById('identificacionForm');
  const submit = document.getElementById('registrarIdentificacion');
  const resultado = document.getElementById('identificacionResultado');
  tipo.required = true;
  fields.querySelectorAll('input, select').forEach((control) => {
    control.required = true;
    if (control.type === 'text') control.maxLength = 255;
  });
  let ciudadesCargadas = false;
  let cargando = false;

  const cargarCiudades = async () => {
    if (ciudadesCargadas || cargando) return;
    cargando = true;
    ciudad.disabled = true;
    retry.hidden = true;
    status.textContent = 'Cargando ciudades de Sonora…';
    try {
      const response = await fetch('/api/localidades?estado=Sonora&cabeceras=1', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('No se pudo consultar el catálogo');
      const data = await response.json();
      if (!Array.isArray(data.localidades)) throw new Error('Catálogo inválido');
      const localidades = [...new Set(data.localidades.filter((value) => typeof value === 'string' && value.trim()))];
      if (!localidades.length) throw new Error('Catálogo vacío');
      ciudad.replaceChildren(new Option('Seleccionar una ciudad', ''));
      localidades.forEach((localidad) => ciudad.add(new Option(localidad, localidad)));
      ciudadesCargadas = true;
      ciudad.disabled = fields.hidden;
      status.textContent = 'Solo cabeceras municipales de Sonora.';
    } catch {
      status.textContent = 'No fue posible cargar las ciudades de Sonora. Reintenta la consulta.';
      retry.hidden = false;
    } finally {
      cargando = false;
    }
  };

  const actualizarLineas = () => {
    if (!count.checkValidity()) return;
    const cantidad = Number(count.value);
    if (!Number.isInteger(cantidad) || cantidad < 1) return;
    // Conservar los valores al reducir y volver a ampliar la cantidad.
    for (let i = container.children.length; i < cantidad; i += 1) {
      const group = document.createElement('div');
      group.className = 'col-12 col-sm-6';
      const label = document.createElement('label');
      label.className = 'form-label small mb-1';
      label.htmlFor = `lineaDescrita${i + 1}`;
      label.textContent = `Línea ${i + 1}`;
      const input = document.createElement('input');
      input.type = 'tel';
      input.id = label.htmlFor;
      input.name = 'lineasDescritas[]';
      input.className = 'form-control form-control-sm';
      input.autocomplete = 'off';
      input.required = true;
      input.maxLength = 50;
      group.append(label, input);
      container.append(group);
    }
    Array.from(container.children).forEach((group, index) => {
      group.hidden = index >= cantidad;
      group.querySelector('input').disabled = fields.hidden || group.hidden;
    });
  };

  const actualizarTipo = () => {
    fields.hidden = tipo.value !== 'Identificación de línea';
    fields.querySelectorAll('input, select').forEach((control) => { control.disabled = fields.hidden; });
    ciudad.disabled = fields.hidden || !ciudadesCargadas;
    actualizarLineas();
    if (!fields.hidden) cargarCiudades();
  };

  tipo.addEventListener('change', actualizarTipo);
  form.addEventListener('invalid', (event) => {
    const section = event.target.closest('details');
    if (section) section.open = true;
  }, true);
  count.addEventListener('input', actualizarLineas);
  retry.addEventListener('click', cargarCiudades);
  let guardando = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (guardando || fields.hidden || !form.reportValidity()) return;
    resultado.hidden = false;
    resultado.className = 'alert alert-danger mt-3 mb-0';
    if (!ciudadesCargadas || !ciudad.value) {
      resultado.textContent = 'Selecciona una cabecera municipal de Sonora antes de registrar.';
      return;
    }
    const formData = new FormData(form);
    const datos = Object.fromEntries(formData);
    datos.lineasDescritas = formData.getAll('lineasDescritas[]');
    delete datos['lineasDescritas[]'];
    guardando = true;
    submit.disabled = true;
    submit.textContent = 'Registrando…';
    resultado.hidden = true;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(datos),
      });
      if (response.redirected) throw new Error('La sesión terminó. Vuelve a iniciar sesión para registrar.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No fue posible guardar la identificación.');
      form.reset();
      container.replaceChildren();
      tipo.value = 'Identificación de línea';
      actualizarTipo();
      fields.querySelectorAll('details').forEach((section, index) => { section.open = index === 0; });
      resultado.className = 'alert alert-success mt-3 mb-0';
      resultado.textContent = `${data.message} Folio: ${data.id}.`;
      document.dispatchEvent(new Event('identificacion-registrada'));
    } catch (error) {
      resultado.className = 'alert alert-danger mt-3 mb-0';
      resultado.textContent = error.message || 'No fue posible guardar. Intenta nuevamente.';
    } finally {
      guardando = false;
      submit.disabled = false;
      submit.textContent = 'Registrar identificación';
      resultado.hidden = false;
    }
  });
  actualizarTipo();
})();
