// The task board: drag and drop between columns, live refresh when someone else changes a task, a card opening
// its details in a window over the board, "Añadir tarjeta" at the foot of each column, search and label filters,
// and @mention suggestions in comments (also on the edit page). Without this script every card is a link to its
// edit page and every form posts as a plain page.
(() => {
  const board = document.querySelector('.tareas-tablero');
  const dialog = document.querySelector('.tarea-modal');
  const filtro = board?.dataset.filtro || '';
  const conFiltro = (path) => `${path}${filtro ? `${path.includes('?') ? '&' : '?'}volver=${encodeURIComponent(filtro)}` : ''}`;
  const notice = (message) => (window.noticeToast || alert)(message);
  let requestRefresh = () => {};

  // ---- Board -------------------------------------------------------------------------------------------------
  if (board) {
    let dragged = null;
    let origin = null;
    let saving = 0;

    const lists = () => [...board.querySelectorAll('.tareas-lista')];
    const enableDrag = () => board.querySelectorAll('.tarea-card').forEach((card) => { card.draggable = true; });

    // Search and label filters hide the cards that do not match, on screen only; counters show how many are left.
    const filtros = { texto: '', etiquetas: new Set() };
    const filtrando = () => Boolean(filtros.texto) || filtros.etiquetas.size > 0;
    const aplicarFiltros = () => {
      const palabras = filtros.texto.toLowerCase().split(/\s+/).filter(Boolean);
      let visibles = 0;
      for (const card of board.querySelectorAll('.tarea-card')) {
        const texto = card.dataset.buscar || '';
        const etiquetas = (card.dataset.etiquetas || '').split(',').filter(Boolean);
        const coincide = palabras.every((palabra) => texto.includes(palabra))
          && (!filtros.etiquetas.size || etiquetas.some((id) => filtros.etiquetas.has(id)));
        card.hidden = !coincide;
        if (coincide) visibles += 1;
      }
      for (const list of lists()) {
        const counter = list.closest('.tareas-columna').querySelector('[data-contador]');
        const total = list.querySelectorAll('.tarea-card').length;
        const shown = list.querySelectorAll('.tarea-card:not([hidden])').length;
        if (counter) counter.textContent = filtrando() ? `${shown}/${total}` : String(total);
      }
      const vacio = document.querySelector('.tareas-sin-resultados');
      if (vacio) vacio.hidden = !(filtrando() && visibles === 0);
    };
    document.querySelectorAll('[data-solo-js]').forEach((element) => { element.hidden = false; });
    document.getElementById('tareasBuscar')?.addEventListener('input', (event) => {
      filtros.texto = event.target.value.trim();
      aplicarFiltros();
    });
    document.querySelectorAll('.tareas-filtro-etiqueta').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.etiqueta;
      const activa = !filtros.etiquetas.has(id);
      if (activa) filtros.etiquetas.add(id);
      else filtros.etiquetas.delete(id);
      button.setAttribute('aria-pressed', String(activa));
      aplicarFiltros();
    }));

    // Columns are ordered by arrival date, oldest first, as the server lists them; ties go by id, the order they were registered.
    const arrivesAfter = (a, b) => a.dataset.llegada > b.dataset.llegada
      || (a.dataset.llegada === b.dataset.llegada && Number(a.dataset.id) > Number(b.dataset.id));
    const placeInOrder = (list, card) => {
      const next = [...list.querySelectorAll('.tarea-card')].find((other) => other !== card && arrivesAfter(other, card)) || null;
      if (card.parentElement !== list || card.nextElementSibling !== next) list.insertBefore(card, next);
    };

    // The board is redrawn on refresh, so the listeners sit on it rather than on each card.
    board.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('.tarea-card');
      if (!card) return;
      dragged = card;
      origin = { list: card.parentElement, next: card.nextElementSibling };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.dataset.id);
      // Deferred so the drag image is taken before the card fades.
      requestAnimationFrame(() => card.classList.add('is-arrastrando'));
    });

    // A drag cancelled with Escape or dropped outside the board leaves the card where it started.
    board.addEventListener('dragend', (event) => {
      const card = event.target.closest?.('.tarea-card');
      if (!card) return;
      card.classList.remove('is-arrastrando');
      lists().forEach((list) => list.classList.remove('is-destino'));
      if (dragged && origin) {
        origin.list.insertBefore(card, origin.next);
        aplicarFiltros();
      }
      dragged = null;
      refreshIfPending();
    });

    board.addEventListener('dragover', (event) => {
      const list = event.target.closest?.('.tareas-columna')?.querySelector('.tareas-lista');
      if (!dragged || !list) return;
      event.preventDefault();
      lists().forEach((other) => other.classList.toggle('is-destino', other === list));
      placeInOrder(list, dragged);
    });

    board.addEventListener('dragleave', (event) => {
      const list = event.target.closest?.('.tareas-lista');
      if (list && !list.contains(event.relatedTarget)) list.classList.remove('is-destino');
    });

    board.addEventListener('drop', async (event) => {
      const list = event.target.closest?.('.tareas-columna')?.querySelector('.tareas-lista');
      if (!dragged || !list) return;
      event.preventDefault();
      const card = dragged;
      const back = origin;
      // Taken over by the drop; dragend must not undo it.
      dragged = null;
      list.classList.remove('is-destino');
      aplicarFiltros();
      // Same column: nothing to save.
      if (back.list === list) return;
      saving += 1;
      try {
        const response = await fetch(`/tareas/${card.dataset.id}/mover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ estado: list.dataset.estado }),
        });
        // An expired session answers with a redirect to the login page instead of JSON.
        if (response.redirected) throw new Error('La sesión expiró. Recargue la página e inicie sesión de nuevo.');
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No fue posible mover la tarea.');
      } catch (error) {
        // Put the card back where it was, so the board matches what is saved.
        if (back.list.isConnected) back.list.insertBefore(card, back.next?.isConnected ? back.next : null);
        aplicarFiltros();
        notice(error.message || 'No fue posible mover la tarea.');
      } finally {
        saving -= 1;
        refreshIfPending();
      }
    });

    // A card opens its details in the window; with Ctrl, Shift or the middle button it opens its page as usual.
    board.addEventListener('click', (event) => {
      const link = event.target.closest?.('.tarea-abrir');
      if (!link || !dialog || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      abrir(link.closest('.tarea-card').dataset.id);
    });

    // ---- Quick add ----
    const rapidaDe = (element) => element.closest?.('.tarea-rapida');
    const cerrarRapida = (rapida) => {
      rapida.open = false;
      rapida.querySelector('.tarea-rapida-error').hidden = true;
      rapida.querySelector('summary')?.focus();
    };
    board.addEventListener('click', (event) => {
      const summary = event.target.closest?.('.tarea-rapida > summary');
      if (summary) {
        const rapida = summary.parentElement;
        requestAnimationFrame(() => { if (rapida.open) rapida.querySelector('textarea')?.focus(); });
      }
      const cerrar = event.target.closest?.('[data-cerrar-rapida]');
      if (cerrar) cerrarRapida(rapidaDe(cerrar));
    });
    board.addEventListener('keydown', (event) => {
      const textarea = event.target.closest?.('.tarea-rapida textarea');
      if (!textarea) return;
      // Enter adds the card, as in Trello; the title is one line anyway.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        textarea.form.requestSubmit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cerrarRapida(rapidaDe(textarea));
      }
    });
    board.addEventListener('submit', async (event) => {
      const rapida = rapidaDe(event.target);
      if (!rapida) return;
      event.preventDefault();
      const form = event.target;
      const error = form.querySelector('.tarea-rapida-error');
      const boton = form.querySelector('[type="submit"]');
      boton.disabled = true;
      saving += 1;
      try {
        const response = await fetch('/tareas', {
          method: 'POST',
          headers: { 'X-Tarea-Rapida': '1', Accept: 'application/json' },
          credentials: 'same-origin',
          body: new URLSearchParams(new FormData(form)),
        });
        if (response.redirected) throw new Error('La sesión expiró. Recargue la página e inicie sesión de nuevo.');
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'No fue posible añadir la tarjeta.');
        error.hidden = true;
        form.querySelector('textarea').value = '';
        requestRefresh();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        boton.disabled = false;
        saving -= 1;
        // The form may have been redrawn meanwhile; focus the one now on screen.
        board.querySelector(`.tarea-rapida[data-estado="${rapida.dataset.estado}"][open] textarea`)?.focus();
        refreshIfPending();
      }
    });
    // What a half-typed quick add holds, so a redraw of the board does not lose it.
    const guardarRapidas = () => [...board.querySelectorAll('.tarea-rapida[open]')].map((rapida) => ({
      estado: rapida.dataset.estado,
      titulo: rapida.querySelector('textarea').value,
      fecha: rapida.querySelector('input[type="date"]').value,
      foco: rapida.contains(document.activeElement),
    }));
    const restaurarRapidas = (guardadas) => guardadas.forEach(({ estado, titulo, fecha, foco }) => {
      const rapida = board.querySelector(`.tarea-rapida[data-estado="${estado}"]`);
      if (!rapida) return;
      rapida.open = true;
      rapida.querySelector('textarea').value = titulo;
      rapida.querySelector('input[type="date"]').value = fecha;
      if (foco) rapida.querySelector('textarea').focus({ preventScroll: true });
    });

    // ---- Live refresh ----
    // Redrawing waits while this person is in the middle of something on the board: dragging a card or saving one.
    let pending = false;
    let fetching = false;
    const busy = () => dragged || saving > 0;

    const refresh = async () => {
      pending = false;
      fetching = true;
      try {
        const response = await fetch(`/tareas/tablero${filtro ? `?responsable=${encodeURIComponent(filtro)}` : ''}`, {
          credentials: 'same-origin', headers: { Accept: 'text/html' },
        });
        if (!response.ok || response.redirected) return;
        const html = await response.text();
        // Something may have started while the columns were on their way; keep it and try again afterwards.
        if (busy()) {
          pending = true;
          return;
        }
        const focusedId = document.activeElement?.closest?.('.tarea-card')?.id;
        const rapidas = guardarRapidas();
        const scroll = board.scrollLeft;
        board.innerHTML = html;
        board.scrollLeft = scroll;
        enableDrag();
        restaurarRapidas(rapidas);
        aplicarFiltros();
        if (focusedId) document.getElementById(focusedId)?.querySelector('.tarea-abrir')?.focus({ preventScroll: true });
      } catch {
        // A failed refresh leaves the board as it is; the next change brings it up to date.
      } finally {
        fetching = false;
        refreshIfPending();
      }
    };

    let retry = null;
    function refreshIfPending() {
      if (!pending || fetching) return;
      if (busy()) {
        retry ??= setTimeout(() => {
          retry = null;
          refreshIfPending();
        }, 1000);
        return;
      }
      refresh();
    }

    requestRefresh = () => {
      pending = true;
      refreshIfPending();
    };

    enableDrag();
    aplicarFiltros();
    // The days since arrival, and with them the yellow and red frames, change with the date and not with any edit,
    // so a board left open redraws itself every half hour.
    setInterval(requestRefresh, 30 * 60 * 1000);
    if ('EventSource' in window) {
      const events = new EventSource('/tareas/eventos');
      events.addEventListener('cambio', requestRefresh);
      // After a dropped connection the browser reconnects by itself; changes made meanwhile are fetched on reopening.
      let lost = false;
      events.addEventListener('error', () => { lost = true; });
      events.addEventListener('open', () => {
        if (lost) requestRefresh();
        lost = false;
      });
    }
  }

  // ---- Task window ---------------------------------------------------------------------------------------------
  const content = dialog?.querySelector('.tarea-modal-contenido');
  let abierta = null;

  // The open task is kept in the address (?tarea=12), so reloading or sharing the link opens it again.
  const ponerEnUrl = (id) => {
    const url = new URL(location.href);
    if (id) url.searchParams.set('tarea', id);
    else url.searchParams.delete('tarea');
    history.replaceState(null, '', url);
  };

  const sesionVencida = () => {
    notice('La sesión expiró. Inicie sesión de nuevo.');
    setTimeout(() => location.reload(), 1500);
  };

  // Puts the server's answer in the window. HTML is the task's details; JSON says it was deleted or not found.
  async function mostrar(response, despues = () => {}) {
    if (response.redirected) return sesionVencida();
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      const data = await response.json().catch(() => ({}));
      if (data.eliminada) {
        dialog.close();
        requestRefresh();
        return undefined;
      }
      notice(data.error || 'No fue posible completar la acción.');
      if (response.status === 404) dialog.close();
      return undefined;
    }
    const html = await response.text();
    const scroll = dialog.scrollTop;
    content.innerHTML = html;
    dialog.scrollTop = scroll;
    despues();
    return undefined;
  }

  async function abrir(id) {
    if (!dialog) return;
    abierta = id;
    content.innerHTML = '<div class="tarea-modal-cargando"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Cargando…</div>';
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    ponerEnUrl(id);
    try {
      const response = await fetch(conFiltro(`/tareas/${id}/editar`), {
        credentials: 'same-origin', headers: { 'X-Tarea-Modal': '1', Accept: 'text/html' },
      });
      if (abierta !== id) return;
      await mostrar(response, () => content.querySelector('[data-cerrar]')?.focus());
    } catch {
      notice('No fue posible abrir la tarea.');
      dialog.close();
    }
  }

  if (dialog) {
    dialog.addEventListener('close', () => {
      const id = abierta;
      abierta = null;
      content.innerHTML = '';
      ponerEnUrl(null);
      // Back to the card it was opened from, which a refresh may have redrawn.
      document.querySelector(`#tarea-${id} .tarea-abrir`)?.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
      if (event.target.closest('[data-cerrar]')) dialog.close();
    });

    // Delete confirmations inside the window ask right there: the page's confirmation toast would sit under it.
    window.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !dialog.contains(form) || !form.dataset.confirm) return;
      if (form.dataset.modalConfirmado === '1') {
        delete form.dataset.modalConfirmado;
        // Already answered here; the page's confirmation must let it through too.
        form.dataset.confirmed = '1';
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (form.nextElementSibling?.classList.contains('tarea-confirmar')) return;
      const box = document.createElement('div');
      box.className = 'tarea-confirmar alert alert-warning d-flex flex-wrap align-items-center gap-2 py-2 mt-2 mb-0';
      box.setAttribute('role', 'alertdialog');
      const pregunta = document.createElement('span');
      pregunta.className = 'me-auto';
      pregunta.textContent = form.dataset.confirm;
      const cancelar = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm btn-secondary', textContent: 'Cancelar' });
      const confirmar = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm btn-danger', textContent: form.dataset.confirmAction || 'Eliminar' });
      cancelar.addEventListener('click', () => { box.remove(); form.querySelector('button')?.focus(); });
      confirmar.addEventListener('click', () => {
        box.remove();
        form.dataset.modalConfirmado = '1';
        form.requestSubmit();
      });
      box.append(pregunta, cancelar, confirmar);
      form.after(box);
      cancelar.focus();
    }, true);

    // Every form in the window is sent without leaving the board; the answer replaces the window's contents.
    dialog.addEventListener('submit', async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      event.preventDefault();
      const { submitter } = event;
      const action = form.getAttribute('action');
      const body = new URLSearchParams(new FormData(form));
      if (submitter?.name) body.set(submitter.name, submitter.value);
      const menuAbierto = Boolean(form.closest('.tarea-menu[open]'));
      form.querySelectorAll('button, input, textarea, select').forEach((field) => { field.disabled = true; });
      try {
        const response = await fetch(action, {
          method: 'POST',
          headers: { 'X-Tarea-Modal': '1', Accept: 'text/html, application/json' },
          credentials: 'same-origin',
          body,
        });
        await mostrar(response, () => {
          // Put the focus back where the person was working, so adding several items or labels in a row is quick.
          if (menuAbierto) content.querySelector('.tarea-menu')?.setAttribute('open', '');
          const foco = /\/checklist$/.test(action) ? content.querySelector('#checklistTexto')
            : /\/comentar$/.test(action) ? content.querySelector('#comentario')
              : /\/etiquetas\/nueva$/.test(action) ? content.querySelector('#etiquetaNombre')
                : content.querySelector(`form[action="${CSS.escape(action)}"] ${submitter?.name ? `[name="${submitter.name}"]` : 'button[type="submit"], button:not([type])'}`)
                  || content.querySelector('.alert') || content.querySelector('[data-cerrar]');
          if (foco?.classList.contains('alert')) foco.setAttribute('tabindex', '-1');
          foco?.focus({ preventScroll: true });
        });
        requestRefresh();
      } catch {
        notice('No fue posible guardar. Revise su conexión e intente de nuevo.');
        form.querySelectorAll('button, input, textarea, select').forEach((field) => { field.disabled = false; });
      }
    });

    // A link to a task (?tarea=12, as notifications send) opens it over the board.
    const inicial = board?.dataset.abrir;
    if (inicial) abrir(inicial);
  }

  // ---- @mentions -------------------------------------------------------------------------------------------------
  // Typing "@" and a few letters in a comment suggests people; Enter or Tab puts the name in.
  let sugerencias = null;
  const cerrarSugerencias = () => {
    if (!sugerencias) return;
    sugerencias.textarea.removeAttribute('aria-activedescendant');
    sugerencias.textarea.setAttribute('aria-expanded', 'false');
    sugerencias.list.remove();
    sugerencias = null;
  };
  const tokenEn = (textarea) => {
    const antes = textarea.value.slice(0, textarea.selectionStart);
    const match = antes.match(/(^|[^\w@.])@([a-z0-9._-]*)$/i);
    return match ? { inicio: antes.length - match[2].length - 1, texto: match[2].toLowerCase() } : null;
  };
  const elegir = (index) => {
    if (!sugerencias) return;
    const { textarea, opciones, token } = sugerencias;
    const usuario = opciones[index];
    if (!usuario) return;
    const fin = textarea.selectionStart;
    textarea.setRangeText(`@${usuario.h} `, token.inicio, fin, 'end');
    cerrarSugerencias();
    textarea.focus();
  };
  const marcar = (index) => {
    sugerencias.activa = index;
    [...sugerencias.list.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    sugerencias.textarea.setAttribute('aria-activedescendant', `tarea-sugerencia-${index}`);
  };
  document.addEventListener('input', (event) => {
    const textarea = event.target;
    if (!(textarea instanceof HTMLTextAreaElement) || !textarea.dataset.usuarios) return;
    const token = tokenEn(textarea);
    let usuarios = [];
    try { usuarios = JSON.parse(textarea.dataset.usuarios); } catch { usuarios = []; }
    const opciones = token ? usuarios.filter(({ h, e }) => h.startsWith(token.texto) || e.toLowerCase().includes(token.texto)).slice(0, 6) : [];
    if (!opciones.length) { cerrarSugerencias(); return; }
    if (!sugerencias || sugerencias.textarea !== textarea) {
      cerrarSugerencias();
      const list = document.createElement('ul');
      list.className = 'tarea-sugerencias';
      list.id = 'tareaSugerencias';
      list.setAttribute('role', 'listbox');
      list.addEventListener('mousedown', (down) => {
        down.preventDefault();
        const item = down.target.closest('li');
        if (item) elegir(Number(item.dataset.index));
      });
      textarea.after(list);
      textarea.setAttribute('aria-controls', list.id);
      textarea.setAttribute('aria-autocomplete', 'list');
      textarea.setAttribute('aria-expanded', 'true');
      sugerencias = { textarea, list };
    }
    Object.assign(sugerencias, { opciones, token });
    sugerencias.list.replaceChildren(...opciones.map(({ h, e }, index) => {
      const item = document.createElement('li');
      item.id = `tarea-sugerencia-${index}`;
      item.setAttribute('role', 'option');
      item.dataset.index = index;
      item.append(`@${h}`, Object.assign(document.createElement('small'), { textContent: e }));
      return item;
    }));
    marcar(0);
  });
  document.addEventListener('keydown', (event) => {
    const textarea = event.target;
    if (!(textarea instanceof HTMLTextAreaElement) || !textarea.dataset.usuarios) return;
    if (sugerencias?.textarea === textarea) {
      const total = sugerencias.opciones.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        marcar((sugerencias.activa + (event.key === 'ArrowDown' ? 1 : total - 1)) % total);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        elegir(sugerencias.activa);
        return;
      }
      if (event.key === 'Escape') {
        // Close the list, not the window.
        event.preventDefault();
        event.stopPropagation();
        cerrarSugerencias();
        return;
      }
    }
    // Ctrl+Enter sends the comment.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      textarea.form?.requestSubmit();
    }
  });
  document.addEventListener('focusout', (event) => {
    if (sugerencias && event.target === sugerencias.textarea) setTimeout(cerrarSugerencias, 0);
  });
})();
