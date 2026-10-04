(() => {
  const tipo = document.getElementById('tipoRegistro');
  const estado = document.getElementById('registrosCarpetasEstado');
  const contenido = document.getElementById('registrosCarpetasContenido');
  const filas = document.getElementById('registrosCarpetasFilas');
  const anterior = document.getElementById('registrosAnterior');
  const siguiente = document.getElementById('registrosSiguiente');
  const paginaTexto = document.getElementById('registrosPagina');
  const retry = document.getElementById('registrosReintentar');
  let pagina = 1, solicitud = 0;

  async function cargar(destino = 1) {
    const actual = ++solicitud;
    contenido.hidden = true;
    retry.hidden = true;
    if (!tipo.value) {
      estado.textContent = 'Selecciona un tipo de registro para consultar sus registros.';
      return;
    }
    estado.textContent = 'Cargando registros…';
    try {
      const response = await fetch(`/metricas/registros?${new URLSearchParams({ tipo: tipo.value, pagina: destino })}`, { headers: { Accept: 'application/json' } });
      if (response.redirected) throw new Error('Vuelve a iniciar sesión para consultar los registros.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No fue posible cargar los registros.');
      if (actual !== solicitud) return;
      pagina = data.pagina;
      estado.textContent = data.total ? `${data.tipo}: ${data.total.toLocaleString('es-MX')} registros. Más recientes primero.` : `No hay registros de ${data.tipo}.`;
      filas.replaceChildren();
      data.registros.forEach(registro => {
        const row = document.createElement('tr');
        for (const key of ['id', 'nuc', 'fecha_envio', 'agencia', 'ciudad']) {
          const cell = document.createElement('td');
          cell.textContent = registro[key] ?? '—';
          row.append(cell);
        }
        if (filas.dataset.canEdit === 'true') {
          const cell = document.createElement('td');
          const editar = document.createElement('button');
          editar.type = 'button';
          editar.className = 'btn btn-outline-primary btn-sm';
          editar.textContent = 'Editar';
          editar.addEventListener('click', () => document.dispatchEvent(new CustomEvent('editar-carpeta', { detail: { tipo: data.tipo, id: registro.id } })));
          cell.append(editar);
          row.append(cell);
        }
        filas.append(row);
      });
      paginaTexto.textContent = `Página ${pagina} de ${data.paginas}`;
      anterior.disabled = pagina <= 1;
      siguiente.disabled = pagina >= data.paginas;
      contenido.hidden = data.total === 0;
    } catch (error) {
      if (actual !== solicitud) return;
      estado.textContent = error.message || 'No fue posible cargar los registros.';
      retry.hidden = false;
    }
  }
  tipo.addEventListener('change', () => cargar());
  document.addEventListener('identificacion-registrada', () => cargar());
  anterior.addEventListener('click', () => cargar(pagina - 1));
  siguiente.addEventListener('click', () => cargar(pagina + 1));
  retry.addEventListener('click', () => cargar(pagina));
  cargar();
})();
