(() => {
  const modal = document.getElementById('editarCarpetaModal');
  const form = document.getElementById('editarCarpetaForm');
  const campos = document.getElementById('editarCarpetaCampos');
  const estado = document.getElementById('editarCarpetaEstado');
  const guardar = document.getElementById('editarCarpetaGuardar');
  const cerrar = document.getElementById('editarCarpetaCerrar');
  let url, schema = [], saving = false, request = 0;
  cerrar.addEventListener('click', () => modal.close());
  modal.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  modal.addEventListener('close', () => { request += 1; });
  const actualizarActa = () => {
    const acta = form.elements.namedItem('acta_destruccion');
    if (!acta) return;
    acta.disabled = form.elements.namedItem('destruccion').value !== 'si';
    acta.parentElement.hidden = acta.disabled;
  };
  document.addEventListener('editar-carpeta', async event => {
    const current = ++request;
    const { tipo, id } = event.detail;
    url = `/metricas/registros/${id}?${new URLSearchParams({ tipo })}`;
    campos.replaceChildren();
    estado.textContent = 'Cargando registro…';
    guardar.disabled = true;
    document.getElementById('editarCarpetaTitulo').textContent = `${tipo} · Folio ${id}`;
    modal.showModal();
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.redirected) throw new Error('No tienes acceso o tu sesión terminó.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (current !== request) return;
      schema = data.campos;
      for (const field of schema) {
        const group = document.createElement('div');
        group.className = ['lines','textarea'].includes(field.tipo) ? 'col-12' : 'col-sm-6';
        const label = document.createElement('label');
        label.className = 'form-label small';
        label.htmlFor = `edit_${field.nombre}`;
        label.textContent = field.etiqueta;
        const input = document.createElement(field.tipo === 'select' ? 'select' : ['lines','textarea'].includes(field.tipo) ? 'textarea' : 'input');
        input.id = label.htmlFor;
        input.name = field.nombre;
        input.required = field.required;
        input.className = field.tipo === 'select' ? 'form-select form-select-sm' : 'form-control form-control-sm';
        if (input.tagName === 'INPUT') input.type = field.tipo;
        if (field.tipo === 'number') { input.min = field.required ? '1' : '0'; input.step = '1'; }
        if (input.tagName === 'TEXTAREA') input.rows = 3;
        if (field.tipo === 'select') {
          input.add(new Option('Seleccionar una opción', ''));
          const options = field.nombre === 'agencia' ? data.agencias : field.nombre === 'ciudad' ? data.ciudades : field.nombre === 'medio' ? ['correo','fisico'] : ['si','no'];
          options.forEach(value => input.add(new Option(({correo:'Correo',fisico:'Físico',si:'Sí',no:'No'})[value] || value, value)));
          const old = data.registro[field.nombre];
          if (old && !options.includes(old)) input.add(new Option(old, old));
        }
        const value = data.registro[field.nombre];
        input.value = field.tipo === 'lines' ? (value || []).map(v => v || '').join('\n') : value ?? '';
        group.append(label, input);
        campos.append(group);
      }
      actualizarActa();
      estado.textContent = '';
      guardar.disabled = false;
    } catch (error) { if (current === request) estado.textContent = error.message; }
  });
  form.addEventListener('change', actualizarActa);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    for (const field of schema.filter(f => f.tipo === 'lines')) {
      body[field.nombre] = body[field.nombre] ? body[field.nombre].split(/\r?\n/) : [];
    }
    saving = true;
    guardar.disabled = cerrar.disabled = true;
    estado.textContent = 'Guardando…';
    try {
      const response = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json'}, body:JSON.stringify(body) });
      if (response.redirected) throw new Error('No tienes acceso o tu sesión terminó.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      modal.close();
      document.dispatchEvent(new Event('identificacion-registrada'));
    } catch (error) { estado.textContent = error.message; }
    finally { saving = false; guardar.disabled = cerrar.disabled = false; }
  });
})();
