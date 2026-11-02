(() => {
  const key = 'correlatador-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Storage may be disabled. */ }
  if (preference !== 'dark' && preference !== 'light') preference = null;
  // Signed in, the theme saved in Mi cuenta wins, so it is the same on every device; "sistema" follows the device.
  const saved = document.querySelector('meta[name="tema-usuario"]')?.content;
  const signedIn = Boolean(saved);
  if (signedIn) {
    preference = { claro: 'light', oscuro: 'dark' }[saved] || null;
    try {
      if (preference) localStorage.setItem(key, preference);
      else localStorage.removeItem(key);
    } catch { /* Storage may be disabled. */ }
  }

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
      if (signedIn) {
        fetch('/cuenta/tema', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tema: preference }),
        }).catch(() => { /* The choice still applies on this device. */ });
      }
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

// Every page loads this file, so it also sets up page changes: the slide direction must be read here,
// before the page is first drawn, and the loading bar script is brought in.
(() => {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('page-direction'));
    sessionStorage.removeItem('page-direction');
  } catch { /* Without storage the page just rises in. */ }
  if (saved?.to?.toLowerCase() === location.pathname.toLowerCase()) {
    const root = document.documentElement;
    root.dataset.entrada = saved.type;
    root.classList.add('entrando-de-lado');
    setTimeout(() => root.classList.remove('entrando-de-lado'), 1000);
  }

  const script = document.createElement('script');
  script.src = '/public/js/page-transitions.js';
  script.defer = true;
  document.head.appendChild(script);
})();
