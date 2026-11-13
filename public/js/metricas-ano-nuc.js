// "Año del NUC" in the folder forms: the current year by default (also after a form is cleared), and the
// case's year when the typed NUC already belongs to exactly one case. With several, it only points them out.
(() => {
  const anoActual = String(new Date().getFullYear());
  const forms = [...document.querySelectorAll('form[action^="/metricas/"]')].filter((form) => form.elements.ano && form.elements.nuc);

  for (const form of forms) {
    const ano = form.elements.ano;
    const nuc = form.elements.nuc;
    ano.min = '2000';
    ano.max = String(Number(anoActual) + 1);
    ano.step = '1';
    const ayuda = document.createElement('div');
    ayuda.className = 'form-text';
    ayuda.id = `${ano.id || 'ano'}Ayuda`;
    ayuda.setAttribute('role', 'status');
    ano.after(ayuda);
    ano.setAttribute('aria-describedby', ayuda.id);
    const porDefecto = () => {
      if (!ano.value) ano.value = anoActual;
      ayuda.textContent = '';
    };
    porDefecto();
    // reset() runs before the browser clears the fields, so the default goes in afterwards.
    form.addEventListener('reset', () => setTimeout(porDefecto));

    let consulta = 0;
    nuc.addEventListener('change', async () => {
      const numero = nuc.value.trim();
      const actual = ++consulta;
      ayuda.textContent = '';
      if (!numero) return;
      try {
        const response = await fetch(`/metricas/caso-anos?${new URLSearchParams({ nuc: numero })}`, { headers: { Accept: 'application/json' } });
        if (!response.ok || actual !== consulta) return;
        const { anos } = await response.json();
        if (!Array.isArray(anos) || !anos.length) return;
        if (anos.length === 1) {
          ano.value = String(anos[0]);
          ayuda.textContent = `Año tomado del caso existente de este NUC (${anos[0]}).`;
        } else {
          ayuda.textContent = `Este NUC tiene casos en ${anos.join(', ')}; confirma el año.`;
        }
      } catch {
        // Without the lookup the year stays as typed.
      }
    });
  }
})();
