(() => {
  const key = 'correlatador-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Storage may be disabled. */ }
  if (preference !== 'dark' && preference !== 'light') preference = null;

  let button;
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (button) {
      const dark = theme === 'dark';
      button.textContent = dark ? '☀ Modo claro' : '☾ Modo oscuro';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Activar modo claro' : 'Activar modo oscuro');
    }
  };
  apply(preference || (system.matches ? 'dark' : 'light'));

  document.addEventListener('DOMContentLoaded', () => {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Keep the session preference. */ }
      apply(preference);
    });
    document.body.appendChild(button);
    apply(document.documentElement.dataset.theme);
  });
  system.addEventListener('change', () => {
    if (!preference) apply(system.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : null;
    apply(preference || (system.matches ? 'dark' : 'light'));
  });
})();
