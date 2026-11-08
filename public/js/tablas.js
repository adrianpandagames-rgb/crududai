// Tables marked with data-tabla="<name>" can be arranged by each person: drag a header to move its column, drag
// its right edge to change the width, pin columns to the left with the pin button, and choose how tight the rows
// are. The arrangement is saved in the person's account (/cuenta/tablas), so it follows them to other computers;
// a copy in this browser, kept per user, draws it right away before the server answers.
// Rows that arrive later (live refresh, results loaded by fetch, pages drawn by script) are arranged as they appear.
(() => {
  const userId = document.querySelector('meta[name="usuario-id"]')?.content;
  if (!userId) return;

  const cacheKey = `correlatador-tablas:${userId}`;
  const DENSIDADES = { compacta: 'Compacta', normal: 'Normal', amplia: 'Amplia' };
  const MIN_ANCHO = 48;
  const MAX_ANCHO = 1200;
  const wide = window.matchMedia('(min-width: 768px)');

  let configs = {};
  try { configs = JSON.parse(localStorage.getItem(cacheKey)) || {}; } catch { configs = {}; }
  const writeCache = () => {
    try { localStorage.setItem(cacheKey, JSON.stringify(configs)); } catch { /* The account still keeps it. */ }
  };

  const states = new Set();
  const stateOf = new WeakMap();
  let uidSeq = 0;

  const slug = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const clamp = (px) => Math.min(Math.max(Math.round(px), MIN_ANCHO), MAX_ANCHO);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  };
  const icon = (name) => el('i', { class: `bi ${name}`, 'aria-hidden': 'true' });

  const configFor = (key) => {
    const saved = configs[key] || {};
    return {
      orden: Array.isArray(saved.orden) ? saved.orden : [],
      anchos: saved.anchos && typeof saved.anchos === 'object' ? saved.anchos : {},
      fijas: Array.isArray(saved.fijas) ? saved.fijas : [],
      densidad: Object.hasOwn(DENSIDADES, saved.densidad) ? saved.densidad : 'normal',
    };
  };

  // ---- Saving ------------------------------------------------------------------------------------------------
  const pendingSaves = new Map();
  const save = (key) => {
    clearTimeout(pendingSaves.get(key));
    pendingSaves.set(key, setTimeout(() => {
      pendingSaves.delete(key);
      fetch('/cuenta/tablas', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabla: key, config: configs[key] || null }),
      }).catch(() => { /* It still applies in this browser. */ });
    }, 500));
  };

  const update = (state, change) => {
    const config = configFor(state.key);
    change(config);
    const original = state.columns.map(({ id }) => id);
    if (config.orden.join() === original.join()) config.orden = [];
    const isDefault = !config.orden.length && !Object.keys(config.anchos).length && !config.fijas.length
      && config.densidad === 'normal';
    if (isDefault) delete configs[state.key];
    else configs[state.key] = config;
    writeCache();
    for (const other of states) if (other.key === state.key) apply(other);
    save(state.key);
  };

  // ---- Arranging ---------------------------------------------------------------------------------------------
  // A row whose cells line up one-to-one with the header is arranged; others (an empty-list message spanning
  // every column) are left alone. A row is assumed to come in the original order the first time it is seen.
  const arrangeRow = (state, row) => {
    const cells = [...row.cells];
    if (cells.length !== state.columns.length || cells.some((cell) => cell.colSpan > 1)) return;
    if (!cells[0].dataset.tpCol) cells.forEach((cell, index) => { cell.dataset.tpCol = state.columns[index].id; });
    if (row.dataset.tpOrden === state.orderKey) return;
    const byId = new Map(cells.map((cell) => [cell.dataset.tpCol, cell]));
    const current = cells.map((cell) => cell.dataset.tpCol).join();
    if (current !== state.orderKey) for (const id of state.final) { const cell = byId.get(id); if (cell) row.append(cell); }
    row.dataset.tpOrden = state.orderKey;
  };

  const arrangeRows = (state) => {
    arrangeRow(state, state.headRow);
    for (const section of [...state.table.tBodies, state.table.tFoot].filter(Boolean)) {
      for (const row of section.rows) arrangeRow(state, row);
    }
  };

  const headerCell = (state, id) => [...state.headRow.cells].find((cell) => cell.dataset.tpCol === id);
  const measure = (state, id) => headerCell(state, id)?.getBoundingClientRect().width || 120;

  // Widths and pinning live in a stylesheet of the table's own, inside a wide-screen media query, so on a phone
  // the stacked-card layout of .table-stack is untouched.
  const updateStyle = (state) => {
    const { anchos } = configFor(state.key);
    const sel = `table[data-tp-uid="${state.uid}"]`;
    const fixed = state.final.some((id) => Object.hasOwn(anchos, id));
    const widthOf = (id) => (fixed && Object.hasOwn(anchos, id) ? anchos[id] : measure(state, id));
    let css = '';
    if (fixed) {
      const total = state.final.reduce((sum, id) => sum + widthOf(id), 0);
      css += `${sel}{table-layout:fixed;width:${Math.round(total)}px!important;min-width:0!important;max-width:none!important}`;
      for (const id of state.final) {
        css += `${sel} [data-tp-col="${id}"]{width:${Math.round(widthOf(id))}px!important;min-width:0!important;max-width:none!important;overflow-wrap:anywhere}`;
      }
    }
    let left = 0;
    state.pinned.forEach((id, index) => {
      css += `${sel} [data-tp-col="${id}"]{position:sticky!important;left:${Math.round(left)}px;z-index:2;background-color:var(--tp-fija-bg)}`;
      css += `${sel} thead [data-tp-col="${id}"]{z-index:3}`;
      if (index === state.pinned.length - 1) css += `${sel} [data-tp-col="${id}"]::after{content:"";position:absolute;top:0;bottom:0;right:-10px;width:10px;pointer-events:none;background:linear-gradient(90deg,var(--tp-fija-sombra),transparent)}`;
      left += widthOf(id);
    });
    css = css ? `@media (min-width: 768px){${css}}` : '';
    if (state.style.textContent !== css) state.style.textContent = css;
  };

  const apply = (state) => {
    const config = configFor(state.key);
    const ids = state.columns.map(({ id }) => id);
    const ordered = [...config.orden.filter((id) => ids.includes(id)), ...ids.filter((id) => !config.orden.includes(id))];
    state.pinned = ordered.filter((id) => config.fijas.includes(id));
    state.final = [...state.pinned, ...ordered.filter((id) => !config.fijas.includes(id))];
    state.orderKey = state.final.join();
    arrangeRows(state);
    for (const name of Object.keys(DENSIDADES)) state.table.classList.toggle(`tp-densidad-${name}`, config.densidad === name);
    updateStyle(state);
    for (const cell of state.headRow.cells) {
      const pinned = state.pinned.includes(cell.dataset.tpCol);
      const button = cell.querySelector(':scope > .tp-pin');
      if (button) {
        const { label } = state.columns.find((column) => column.id === cell.dataset.tpCol);
        button.setAttribute('aria-pressed', String(pinned));
        button.title = pinned ? `Soltar ${label}` : `Fijar ${label}`;
        button.setAttribute('aria-label', `${pinned ? 'Soltar' : 'Fijar'} la columna ${label}`);
        button.replaceChildren(icon(pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'));
      }
      cell.draggable = wide.matches;
    }
    renderToolbar(state, config);
  };

  // ---- Header controls ---------------------------------------------------------------------------------------
  const moveColumn = (state, id, targetId, after) => {
    if (id === targetId) return;
    update(state, (config) => {
      const order = state.final.filter((other) => other !== id);
      order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id);
      config.orden = order;
      // Dropping among pinned columns pins it; among the others, unpins it.
      const pinTarget = state.pinned.includes(targetId);
      config.fijas = config.fijas.filter((other) => other !== id);
      if (pinTarget) config.fijas.push(id);
    });
  };

  const togglePin = (state, id) => update(state, (config) => {
    config.fijas = config.fijas.includes(id) ? config.fijas.filter((other) => other !== id) : [...config.fijas, id];
  });

  // The first resize freezes every column at the width it has now, so the others do not jump around.
  const resizeTo = (state, id, width) => {
    const config = configFor(state.key);
    const anchos = { ...config.anchos };
    for (const other of state.final) if (!Object.hasOwn(anchos, other)) anchos[other] = clamp(measure(state, other));
    anchos[id] = clamp(width);
    return anchos;
  };

  const setupHeader = (state) => {
    let dragged = null;
    let resizing = false;
    const clearMarks = () => {
      for (const cell of state.headRow.cells) cell.classList.remove('tp-soltar-antes', 'tp-soltar-despues', 'tp-arrastrando');
    };

    for (const cell of state.headRow.cells) {
      const { id, label } = state.columns.find((column) => column.id === cell.dataset.tpCol);
      cell.classList.add('tp-th');

      const pin = el('button', { type: 'button', class: 'tp-pin', 'aria-pressed': 'false', title: `Fijar ${label}`, 'aria-label': `Fijar la columna ${label}` });
      // Pinning moves the column, and moving it drops the focus; put it back on the button.
      pin.addEventListener('click', (event) => { event.stopPropagation(); togglePin(state, id); pin.focus(); });

      const handle = el('span', {
        class: 'tp-resize', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
        title: 'Arrastra para cambiar el ancho', 'aria-label': `Ancho de ${label}; usa las flechas izquierda y derecha`,
      });
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        resizing = true;
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = measure(state, id);
        let anchos = null;
        const onMove = (move) => {
          anchos = resizeTo(state, id, startWidth + move.clientX - startX);
          configs[state.key] = { ...configFor(state.key), anchos };
          updateStyle(state);
        };
        const onUp = () => {
          resizing = false;
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          if (anchos) update(state, (config) => { config.anchos = anchos; });
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
      handle.addEventListener('keydown', (event) => {
        const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
        if (!step) return;
        event.preventDefault();
        update(state, (config) => { config.anchos = resizeTo(state, id, measure(state, id) + step); });
      });
      handle.addEventListener('click', (event) => event.stopPropagation());

      cell.append(pin, handle);

      cell.addEventListener('dragstart', (event) => {
        if (resizing || !wide.matches) { event.preventDefault(); return; }
        dragged = id;
        cell.classList.add('tp-arrastrando');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', label);
      });
      cell.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = cell.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        cell.classList.toggle('tp-soltar-antes', !after && dragged !== id);
        cell.classList.toggle('tp-soltar-despues', after && dragged !== id);
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('tp-soltar-antes', 'tp-soltar-despues'));
      cell.addEventListener('drop', (event) => {
        if (!dragged) return;
        event.preventDefault();
        const after = cell.classList.contains('tp-soltar-despues');
        const source = dragged;
        dragged = null;
        clearMarks();
        moveColumn(state, source, id, after);
      });
      cell.addEventListener('dragend', () => { dragged = null; clearMarks(); });
    }
  };

  // ---- Toolbar -----------------------------------------------------------------------------------------------
  const renderToolbar = (state, config) => {
    const { bar } = state;
    const wasOpen = bar.querySelector('details')?.open;
    const focusedAction = document.activeElement && bar.contains(document.activeElement) ? document.activeElement.dataset.tpAccion : null;

    const list = el('ol', { class: 'tp-lista' });
    state.final.forEach((id, index) => {
      const { label } = state.columns.find((column) => column.id === id);
      const pinned = state.pinned.includes(id);
      const sameGroup = (other) => other !== undefined && state.pinned.includes(other) === pinned;
      const up = el('button', { type: 'button', class: 'btn btn-sm btn-link', 'data-tp-accion': `subir-${id}`, title: 'Mover a la izquierda', 'aria-label': `Mover ${label} a la izquierda` }, [icon('bi-arrow-up')]);
      const down = el('button', { type: 'button', class: 'btn btn-sm btn-link', 'data-tp-accion': `bajar-${id}`, title: 'Mover a la derecha', 'aria-label': `Mover ${label} a la derecha` }, [icon('bi-arrow-down')]);
      const pin = el('button', { type: 'button', class: 'btn btn-sm btn-link', 'data-tp-accion': `fijar-${id}`, 'aria-pressed': String(pinned), title: pinned ? 'Soltar' : 'Fijar a la izquierda', 'aria-label': `${pinned ? 'Soltar' : 'Fijar'} ${label}` }, [icon(pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle')]);
      up.disabled = !sameGroup(state.final[index - 1]);
      down.disabled = !sameGroup(state.final[index + 1]);
      up.addEventListener('click', () => moveColumn(state, id, state.final[index - 1], false));
      down.addEventListener('click', () => moveColumn(state, id, state.final[index + 1], true));
      pin.addEventListener('click', () => togglePin(state, id));
      list.append(el('li', {}, [el('span', { class: 'tp-nombre', text: label }), up, down, pin]));
    });

    const details = el('details', { class: 'tp-columnas' }, [
      el('summary', { class: 'btn btn-sm btn-outline-secondary' }, [icon('bi-layout-three-columns'), ' Columnas']),
      el('div', { class: 'tp-panel' }, [
        el('p', { class: 'tp-ayuda', text: 'Arrastra un encabezado para moverlo y su borde derecho para cambiar el ancho. Las columnas fijas se quedan a la izquierda al desplazarte.' }),
        list,
      ]),
    ]);
    details.open = Boolean(wasOpen);

    const density = el('div', { class: 'btn-group btn-group-sm', role: 'group', 'aria-label': 'Densidad de las filas' });
    for (const [name, text] of Object.entries(DENSIDADES)) {
      const button = el('button', { type: 'button', class: `btn btn-outline-secondary${config.densidad === name ? ' active' : ''}`, 'aria-pressed': String(config.densidad === name), 'data-tp-accion': `densidad-${name}`, text });
      button.addEventListener('click', () => update(state, (next) => { next.densidad = name; }));
      density.append(button);
    }

    const children = [details, density];
    if (configs[state.key]) {
      const reset = el('button', { type: 'button', class: 'btn btn-sm btn-link tp-restablecer', 'data-tp-accion': 'restablecer', text: 'Restablecer' });
      reset.addEventListener('click', () => update(state, (next) => {
        next.orden = []; next.anchos = {}; next.fijas = []; next.densidad = 'normal';
      }));
      children.push(reset);
    }
    bar.replaceChildren(...children);
    if (focusedAction) (bar.querySelector(`[data-tp-accion="${focusedAction}"]:not(:disabled)`) || bar.querySelector('summary'))?.focus();
  };

  // ---- Discovery ---------------------------------------------------------------------------------------------
  const enhance = (table) => {
    const key = table.dataset.tabla;
    const head = table.tHead;
    if (!/^[a-z0-9-]{1,60}$/.test(key || '') || !head || head.rows.length !== 1) return;
    const headRow = head.rows[0];
    if ([...headRow.cells].some((cell) => cell.colSpan > 1) || headRow.cells.length < 2) return;
    // A <colgroup> sizes columns by position, which would stick to the wrong ones once they move;
    // its widths go onto the header cells instead.
    for (const group of table.querySelectorAll(':scope > colgroup')) {
      const cols = [...group.children];
      if (cols.length === headRow.cells.length && cols.every((col) => col.span === 1)) {
        cols.forEach((col, index) => { if (col.style.width && !headRow.cells[index].style.width) headRow.cells[index].style.width = col.style.width; });
        group.remove();
      }
    }

    const used = new Set();
    const columns = [...headRow.cells].map((cell, index) => {
      const label = cell.textContent.replace(/\s+/g, ' ').trim() || cell.getAttribute('aria-label') || `Columna ${index + 1}`;
      let id = (cell.dataset.col && slug(cell.dataset.col)) || slug(label) || `col-${index + 1}`;
      for (let n = 2; used.has(id); n += 1) id = `${id.replace(/-\d+$/, '')}-${n}`;
      used.add(id);
      cell.dataset.tpCol = id;
      return { id, label };
    });

    const uid = String(++uidSeq);
    table.dataset.tpUid = uid;
    const style = el('style', { 'data-tp-estilo': uid });
    document.head.append(style);

    // The bar sits outside the scrolling box; a table redrawn in place takes over the bar it left behind.
    const container = table.closest('.table-responsive') || table;
    const previous = container.previousElementSibling;
    const bar = previous?.matches('.tp-barra') && previous.dataset.tpBarra === key ? previous : el('div', { class: 'tp-barra', 'data-tp-barra': key });
    if (bar !== previous) container.before(bar);

    const state = { table, key, headRow, columns, uid, style, bar, final: [], pinned: [], orderKey: '' };
    stateOf.set(table, state);
    states.add(state);
    setupHeader(state);
    apply(state);

    // Pinned columns stack by their widths, which move when the table reflows on its own.
    let frame = 0;
    state.observer = new ResizeObserver(() => {
      if (!state.pinned.length || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; updateStyle(state); });
    });
    state.observer.observe(table);
  };

  const scan = () => {
    for (const state of states) {
      if (state.table.isConnected) continue;
      state.style.remove();
      state.observer?.disconnect();
      if (state.bar.isConnected && !document.querySelector(`table[data-tabla="${state.key}"]`)) state.bar.remove();
      states.delete(state);
    }
    for (const table of document.querySelectorAll('table[data-tabla]')) {
      const state = stateOf.get(table);
      if (state) arrangeRows(state);
      else enhance(table);
    }
  };

  let scheduled = 0;
  const scheduleScan = () => {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => { scheduled = 0; scan(); });
  };

  const start = () => {
    scan();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    wide.addEventListener('change', () => states.forEach(apply));
    // Close the column menu when clicking elsewhere.
    document.addEventListener('click', (event) => {
      // A button inside the menu redraws it, so its click arrives from an element no longer on the page.
      if (!event.target.isConnected) return;
      for (const open of document.querySelectorAll('.tp-columnas[open]')) if (!open.contains(event.target)) open.open = false;
    });
    fetch('/cuenta/tablas', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((response) => (response.ok && !response.redirected ? response.json() : null))
      .then((saved) => {
        if (!saved || typeof saved !== 'object') return;
        // A change made while the request was out wins over what it brought back.
        for (const key of pendingSaves.keys()) saved[key] = configs[key];
        configs = saved;
        writeCache();
        states.forEach(apply);
      })
      .catch(() => { /* The copy in this browser stays. */ });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
