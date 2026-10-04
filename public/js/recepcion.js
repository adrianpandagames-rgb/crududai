(() => {
  const tipo = document.getElementById('tipoRegistro');
  const form = document.getElementById('recepcionForm');
  const ciudad = document.getElementById('rec_ciudad');
  const status = document.getElementById('rec_ciudadStatus');
  const retry = document.getElementById('rec_retry');
  const destruccion = document.getElementById('rec_destruccion');
  const acta = document.getElementById('rec_acta_destruccion');
  const actaGroup = document.getElementById('recepcionActaGroup');
  const button = document.getElementById('rec_registrar');
  const resultado = document.getElementById('rec_resultado');
  let cargadas = false, cargando = false, guardando = false;

  function actualizarActa() {
    actaGroup.hidden = destruccion.value !== 'si';
    acta.disabled = form.hidden || actaGroup.hidden;
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
    form.hidden = tipo.value !== 'Recepción';
    form.querySelectorAll('input, select, button').forEach(control => { control.disabled = form.hidden; });
    ciudad.disabled = form.hidden || !cargadas;
    actualizarActa();
    if (!form.hidden) cargarCiudades();
  }
  form.addEventListener('invalid', (event) => {
    const section = event.target.closest('details');
    if (section) section.open = true;
  }, true);
  destruccion.addEventListener('change', actualizarActa);
  retry.addEventListener('click', cargarCiudades);
  tipo.addEventListener('change', actualizarTipo);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (guardando || form.hidden || !form.reportValidity()) return;
    const datos = Object.fromEntries(new FormData(form));
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
      actualizarTipo();
      form.querySelectorAll('details').forEach((section, index) => { section.open = index === 0; });
      resultado.className = 'alert alert-success mt-3 mb-0';
      resultado.textContent = `${data.message} Folio: ${data.id}.`;
      document.dispatchEvent(new Event('identificacion-registrada'));
    } catch (error) {
      resultado.className = 'alert alert-danger mt-3 mb-0';
      resultado.textContent = error.message || 'No fue posible guardar. Intenta nuevamente.';
    } finally {
      guardando = false;
      button.disabled = false;
      tipo.disabled = false;
      button.textContent = 'Registrar recepción';
      resultado.hidden = false;
    }
  });
  actualizarTipo();
})();
