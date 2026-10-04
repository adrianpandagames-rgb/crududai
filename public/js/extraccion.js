(() => {
  const tipo = document.getElementById('tipoRegistro');
  const form = document.getElementById('extraccionForm');
  const ciudad = document.getElementById('ext_ciudad');
  const status = document.getElementById('ext_ciudadStatus');
  const retry = document.getElementById('ext_retry');
  const button = document.getElementById('ext_registrar');
  const resultado = document.getElementById('ext_resultado');
  let cargadas = false, cargando = false, guardando = false;

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
    form.hidden = tipo.value !== 'Extracción';
    form.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = form.hidden; });
    ciudad.disabled = form.hidden || !cargadas;
    if (!form.hidden) cargarCiudades();
  }
  form.addEventListener('invalid', (event) => {
    const section = event.target.closest('details');
    if (section) section.open = true;
  }, true);
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
      button.textContent = 'Registrar extracción';
      resultado.hidden = false;
    }
  });
  actualizarTipo();
})();
