// Drag and drop for the task board, and live refresh when someone else changes a task. Without this script the
// arrow buttons still move cards, which is also how touch screens move them, since they do not fire HTML drag events.
(() => {
  const board = document.querySelector('.tareas-tablero');
  if (!board) return;
  let dragged = null;
  let origin = null;
  let saving = 0;

  const lists = () => [...board.querySelectorAll('.tareas-lista')];
  const updateCounts = () => lists().forEach((list) => {
    const counter = list.closest('.tareas-columna').querySelector('[data-contador]');
    if (counter) counter.textContent = list.querySelectorAll('.tarea-card').length;
  });
  const enableDrag = () => board.querySelectorAll('.tarea-card').forEach((card) => { card.draggable = true; });

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
      updateCounts();
    }
    dragged = null;
    refreshIfPending();
  });

  board.addEventListener('dragover', (event) => {
    const list = event.target.closest?.('.tareas-lista');
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
    const list = event.target.closest?.('.tareas-lista');
    if (!dragged || !list) return;
    event.preventDefault();
    const card = dragged;
    const back = origin;
    // Taken over by the drop; dragend must not undo it.
    dragged = null;
    list.classList.remove('is-destino');
    updateCounts();
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
      updateCounts();
      (window.noticeToast || alert)(error.message || 'No fue posible mover la tarea.');
    } finally {
      saving -= 1;
      refreshIfPending();
    }
  });

  // Live refresh. Redrawing waits while this person is in the middle of something on the board: dragging a card,
  // saving a drop, or answering the delete confirmation, whose form would be replaced under it.
  let pending = false;
  let fetching = false;
  const busy = () => dragged || saving > 0 || document.querySelector('.confirm-toast:not(.is-notice)');

  const refresh = async () => {
    pending = false;
    fetching = true;
    try {
      const filtro = board.dataset.filtro;
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
      board.innerHTML = html;
      enableDrag();
      if (focusedId) document.getElementById(focusedId)?.querySelector('a, button')?.focus({ preventScroll: true });
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
      // The confirmation toast does not announce when it closes, so check again shortly.
      retry ??= setTimeout(() => {
        retry = null;
        refreshIfPending();
      }, 1000);
      return;
    }
    refresh();
  }

  const requestRefresh = () => {
    pending = true;
    refreshIfPending();
  };

  enableDrag();
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
})();
