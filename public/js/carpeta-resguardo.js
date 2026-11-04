// "Carpeta resguardo" select with a + button that adds a new option to the shared catalog.
document.querySelectorAll('[data-carpeta-resguardo]').forEach((widget) => {
  const select = widget.querySelector('select');
  const agregar = widget.querySelector('[data-carpeta-agregar]');
  const nueva = widget.querySelector('[data-carpeta-nueva]');
  const input = nueva.querySelector('input');
  const guardar = widget.querySelector('[data-carpeta-guardar]');
  const cancelar = widget.querySelector('[data-carpeta-cancelar]');
  const estado = widget.querySelector('[data-carpeta-estado]');
  let guardando = false;

  const cerrar = () => {
    nueva.hidden = true;
    input.value = '';
    agregar.focus();
  };
  agregar.addEventListener('click', () => {
    nueva.hidden = false;
    estado.textContent = '';
    input.focus();
  });
  cancelar.addEventListener('click', cerrar);

  const enviar = async () => {
    const nombre = input.value.trim();
    if (guardando) return;
    if (!nombre) {
      estado.textContent = 'Escribe el nombre de la carpeta resguardo.';
      input.focus();
      return;
    }
    guardando = true;
    guardar.disabled = true;
    estado.textContent = 'Agregando…';
    try {
      const response = await fetch('/metricas/carpetas-resguardo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ nombre }),
      });
      if (response.redirected) throw new Error('La sesión terminó. Vuelve a iniciar sesión.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No fue posible agregar la opción.');
      const existente = Array.from(select.options).find(option => option.value === data.nombre);
      if (!existente) {
        // Keep the list alphabetical, after the placeholder.
        const siguiente = Array.from(select.options).slice(1).find(option => option.value.localeCompare(data.nombre, 'es') > 0);
        select.add(new Option(data.nombre, data.nombre), siguiente || null);
      }
      select.value = data.nombre;
      cerrar();
      estado.textContent = existente ? `"${data.nombre}" ya estaba en la lista y quedó seleccionada.` : data.message;
    } catch (error) {
      estado.textContent = error.message || 'No fue posible agregar la opción. Intenta nuevamente.';
    } finally {
      guardando = false;
      guardar.disabled = false;
    }
  };
  guardar.addEventListener('click', enviar);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      enviar();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cerrar();
    }
  });
});
