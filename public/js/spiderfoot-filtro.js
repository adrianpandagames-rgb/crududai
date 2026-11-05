// Filters the SpiderFoot results as the person types: rows that do not match hide, groups with a match open and
// groups or categories left empty hide. Listens on the document because the results arrive by live refresh.
(() => {
  const apply = (input) => {
    const query = input.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('.spiderfoot-type-group').forEach((group) => {
      if (group.dataset.wasOpen === undefined) group.dataset.wasOpen = group.open ? '1' : '';
      let matches = 0;
      group.querySelectorAll('tr[data-filter-text]').forEach((row) => {
        const match = !query || row.dataset.filterText.includes(query);
        row.hidden = !match;
        if (match) matches++;
      });
      shown += matches;
      group.hidden = matches === 0;
      group.open = query ? matches > 0 : group.dataset.wasOpen === '1';
    });
    document.querySelectorAll('.spiderfoot-category').forEach((category) => {
      category.hidden = ![...category.querySelectorAll('.spiderfoot-type-group')].some((group) => !group.hidden);
    });
    const status = document.getElementById('spiderfootFiltroEstado');
    if (status) status.textContent = query ? `${shown} resultado(s) coinciden.` : '';
  };
  document.addEventListener('input', (event) => {
    if (event.target.id === 'spiderfootFiltro') apply(event.target);
  });
})();
