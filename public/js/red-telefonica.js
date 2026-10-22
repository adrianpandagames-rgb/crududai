(() => {
  const container = document.getElementById('networkGraph');
  const form = document.getElementById('networkSearch');
  const numberInput = document.getElementById('networkNumber');
  const resetButton = document.getElementById('networkReset');
  const layoutSelect = document.getElementById('networkLayout');
  const autoCheck = document.getElementById('networkAuto');
  const pngButton = document.getElementById('networkPng');
  const status = document.getElementById('networkStatus');
  const panel = document.getElementById('networkPanel');
  if (!container || typeof cytoscape !== 'function') {
    if (status) status.textContent = 'No fue posible cargar la librería de la red. Revisa la conexión a internet.';
    return;
  }

  let currentNumber = '';
  let lastSignature = '';
  let data = { nodes: [], links: [] };

  const cy = cytoscape({
    container,
    // Large graphs stay responsive when edges hide while panning.
    hideEdgesOnViewport: true,
    wheelSensitivity: 0.25,
    minZoom: 0.05,
    maxZoom: 4,
    style: [
      { selector: 'node', style: {
        'background-color': '#9aa9b6', width: 8, height: 8, label: 'data(label)', 'font-size': 7, color: '#17324d',
        'text-valign': 'bottom', 'text-margin-y': 3, 'min-zoomed-font-size': 9, 'border-width': 1, 'border-color': '#fff',
      } },
      { selector: 'node[type = "objective"]', style: {
        'background-color': '#087f8c', shape: 'round-rectangle', width: 34, height: 22, 'font-size': 11, 'font-weight': 700,
        label: 'data(caption)', 'text-wrap': 'wrap', 'min-zoomed-font-size': 4, 'border-width': 2,
      } },
      { selector: 'node[crossings > 1]', style: {
        'background-color': '#e47b39', width: 14, height: 14, 'font-size': 9, 'font-weight': 700, 'min-zoomed-font-size': 5,
      } },
      { selector: 'node[?isObjectiveLine]', style: {
        'background-color': '#b42318', shape: 'diamond', width: 18, height: 18, 'font-size': 9, 'font-weight': 700, 'min-zoomed-font-size': 5,
      } },
      { selector: 'node[?isFocus]', style: {
        'border-width': 5, 'border-color': '#facc15', width: 40, height: 40, 'font-size': 13, 'min-zoomed-font-size': 1, 'z-index': 99,
      } },
      { selector: 'edge', style: {
        width: 0.6, 'line-color': '#2f55e4', opacity: 0.45, 'curve-style': 'straight',
      } },
      { selector: 'edge[kind = "linea"]', style: {
        width: 2.5, 'line-color': '#b42318', 'line-style': 'dashed', opacity: 0.9,
      } },
      { selector: '.faded', style: { opacity: 0.08 } },
      { selector: 'node.highlight', style: { 'min-zoomed-font-size': 1, 'z-index': 50 } },
      { selector: 'edge.highlight', style: { opacity: 1, width: 1.6 } },
      { selector: 'node:selected', style: { 'border-width': 4, 'border-color': '#111827' } },
    ],
  });

  // Labels follow the page theme so they stay readable on the dark canvas too.
  const applyThemeColors = () => {
    const styles = getComputedStyle(container);
    const ink = getComputedStyle(document.querySelector('.network-page')).getPropertyValue('--network-ink').trim() || '#17324d';
    cy.style().selector('node').style({ color: ink, 'text-outline-color': styles.backgroundColor, 'text-outline-width': 2 }).update();
  };
  applyThemeColors();
  new MutationObserver(applyThemeColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle('error', isError);
  };

  // The hierarchy puts every contact of a level in one row and the organic layout grows quadratically,
  // so big networks fall back to rings: focus, objectives, crossings and then plain contacts.
  const MAX_HIERARCHY_NODES = 600;
  const MAX_ORGANIC_NODES = 500;
  const ringLevel = (node) => (node.data('isFocus') ? 4 : node.data('type') === 'objective' ? 3
    : node.data('crossings') > 1 || node.data('isObjectiveLine') ? 2 : 1);

  const runLayout = () => {
    if (cy.elements().empty()) return;
    const size = cy.nodes().length;
    let name = layoutSelect.value;
    if (name === 'auto') name = size > MAX_HIERARCHY_NODES ? 'concentric' : 'breadthfirst';
    if (name === 'cose' && size > MAX_ORGANIC_NODES) {
      name = 'concentric';
      setStatus(`El acomodo orgánico solo está disponible hasta ${MAX_ORGANIC_NODES} nodos; se usan anillos.`, true);
    }
    const roots = cy.nodes('[?isFocus][type = "objective"]').nonempty()
      ? cy.nodes('[?isFocus][type = "objective"]')
      : cy.nodes('[type = "objective"]');
    const options = {
      breadthfirst: { name, roots, spacingFactor: 1.1, avoidOverlap: true, circle: false },
      cose: { name, animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 60, numIter: 1000 },
      concentric: { name, concentric: ringLevel, levelWidth: () => 1, minNodeSpacing: 4, avoidOverlap: true },
    }[name];
    cy.layout({ ...options, fit: true, padding: 30 }).run();
  };

  const render = (payload) => {
    data = payload;
    const elements = [
      ...payload.nodes.map((node) => ({ group: 'nodes', data: {
        ...node,
        caption: node.type === 'objective' ? `${node.label}\nNUC ${node.nuc}` : node.label,
      } })),
      ...payload.links.map((link) => ({ group: 'edges', data: link })),
    ];
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    runLayout();
    const focus = cy.nodes('[?isFocus]');
    if (focus.nonempty()) {
      highlight(focus);
      showDetail(focus.first());
    } else {
      clearHighlight();
      showEmptyPanel();
    }
  };

  const describe = (payload) => {
    const objectives = payload.nodes.filter((node) => node.type === 'objective').length;
    const crossings = payload.nodes.filter((node) => node.crossings > 1).length;
    const phones = payload.nodes.length - objectives;
    const scope = currentNumber ? `Enfoque en ${currentNumber}: ` : '';
    const warning = payload.truncated ? ' Se alcanzó el límite de registros; la red está incompleta.' : '';
    return `${scope}${objectives} objetivo(s), ${phones} contacto(s), ${crossings} en cruce.${warning}`;
  };

  const load = async ({ quiet = false } = {}) => {
    const params = new URLSearchParams();
    if (currentNumber) params.set('numero', currentNumber);
    if (!quiet) setStatus('Cargando red…');
    try {
      const response = await fetch(`/red-telefonica/datos?${params}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'No fue posible cargar la red.');
      if (currentNumber && payload.found === false) {
        setStatus(`La línea ${currentNumber} no aparece en ningún objetivo ni contacto.`, true);
        return;
      }
      const signature = `${params}|${payload.nodes.length}|${payload.links.length}|${payload.links.map((link) => link.id).join(',')}`;
      // Auto refresh only redraws when new records arrived, so the analyst keeps the current zoom.
      if (quiet && signature === lastSignature) return;
      lastSignature = signature;
      render(payload);
      setStatus(describe(payload));
    } catch (error) {
      setStatus(error.message, true);
    }
  };

  const clearHighlight = () => cy.elements().removeClass('faded highlight');

  const highlight = (nodes) => {
    const neighborhood = nodes.closedNeighborhood();
    // A focused contact also shows the other contacts of the objectives it touches.
    const extended = neighborhood.union(neighborhood.nodes('[type = "objective"]').closedNeighborhood());
    cy.elements().addClass('faded').removeClass('highlight');
    extended.removeClass('faded').addClass('highlight');
  };

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const focusButton = (number, text = 'Enfocar en esta línea') => {
    const button = element('button', 'btn btn-sm btn-outline-primary', text);
    button.type = 'button';
    button.addEventListener('click', () => focusOn(number));
    return button;
  };

  const showEmptyPanel = () => {
    panel.replaceChildren(element('div', 'network-panel-empty', 'Selecciona un nodo para ver su detalle. Doble clic sobre una línea para enfocarla.'));
  };

  const listOf = (title, nodes, describeNode) => {
    const section = element('div', 'network-panel-section');
    section.append(element('div', 'network-panel-label', `${title} (${nodes.length})`));
    const list = element('div', 'network-panel-list');
    nodes.forEach((node) => {
      const item = element('button', 'network-chip', describeNode(node));
      item.type = 'button';
      item.addEventListener('click', () => {
        cy.$(':selected').unselect();
        const target = cy.getElementById(node.id());
        target.select();
        cy.animate({ center: { eles: target }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 300 });
        highlight(target);
        showDetail(target);
      });
      list.append(item);
    });
    section.append(list);
    return section;
  };

  const showDetail = (node) => {
    const info = node.data();
    const children = [];
    if (info.type === 'objective') {
      children.push(element('div', 'network-panel-kind', 'Objetivo'), element('div', 'network-panel-title', info.label));
      const meta = element('dl', 'network-panel-meta');
      [['NUC', info.nuc], ['Tipo', info.tipo], ['Año', info.ano], ['Delito', info.delito || '—'],
        ['Contactos registrados', info.totalContacts], ['Contactos en cruce', info.crossingContacts]].forEach(([label, value]) => {
        meta.append(element('dt', '', label), element('dd', '', String(value)));
      });
      children.push(meta, focusButton(info.number));
      const contacts = node.neighborhood('node');
      const crossing = contacts.filter((other) => other.data('crossings') > 1 || other.data('isObjectiveLine'));
      if (crossing.nonempty()) children.push(listOf('Contactos que lo cruzan con otros objetivos', crossing, (other) => `${other.data('label')} · ${other.data('crossings')} objetivo(s)`));
    } else {
      const kind = info.isObjectiveLine ? 'Contacto que también es línea objetivo' : info.crossings > 1 ? 'Contacto en cruce' : 'Contacto';
      children.push(element('div', 'network-panel-kind', kind), element('div', 'network-panel-title', info.label));
      children.push(element('p', 'network-panel-note', `Aparece en ${info.crossings} objetivo(s).`), focusButton(info.number));
      const objectives = node.neighborhood('node[type = "objective"]');
      children.push(listOf('Objetivos relacionados', objectives, (other) => `${other.data('label')} · NUC ${other.data('nuc')} · ${other.data('ano')}`));
    }
    panel.replaceChildren(...children);
  };

  const focusOn = (number) => {
    currentNumber = String(number).replace(/\D/g, '');
    numberInput.value = currentNumber;
    const url = new URL(window.location.href);
    url.searchParams.set('numero', currentNumber);
    history.replaceState(null, '', url);
    load();
  };

  cy.on('tap', 'node', (event) => {
    highlight(event.target);
    showDetail(event.target);
  });
  cy.on('tap', (event) => {
    if (event.target === cy) {
      clearHighlight();
      showEmptyPanel();
    }
  });
  cy.on('dbltap', 'node', (event) => focusOn(event.target.data('number')));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const digits = numberInput.value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      setStatus('Ingresa un número de 7 a 15 dígitos.', true);
      return;
    }
    focusOn(digits);
  });
  resetButton.addEventListener('click', () => {
    currentNumber = '';
    numberInput.value = '';
    const url = new URL(window.location.href);
    url.searchParams.delete('numero');
    history.replaceState(null, '', url);
    load();
  });
  layoutSelect.addEventListener('change', runLayout);
  pngButton.addEventListener('click', () => {
    if (cy.elements().empty()) return;
    const link = document.createElement('a');
    link.href = cy.png({ full: true, scale: 2, bg: getComputedStyle(container).backgroundColor, maxWidth: 12000, maxHeight: 12000 });
    link.download = `red-${currentNumber || 'general'}.png`;
    link.click();
  });
  setInterval(() => {
    if (autoCheck.checked && !document.hidden) load({ quiet: true });
  }, 60000);

  const initial = numberInput.value.replace(/\D/g, '');
  if (initial.length >= 7) focusOn(initial);
  else load();
})();
