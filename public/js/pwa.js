// Registers the service worker that makes the app installable, and offers "Instalar app" in the user menu
// when the browser allows installing it (Chrome, Edge, Android). On iPhone it is installed from Share ›
// Add to Home Screen, which the browser does not let a page trigger.
(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* The site works the same without it. */ });
  });

  let prompt = null;
  const boton = () => document.querySelector('[data-instalar-app]');
  const mostrar = (visible) => { const item = boton()?.closest('li'); if (item) item.hidden = !visible; };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event;
    mostrar(true);
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    mostrar(false);
  });
  document.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-instalar-app]') || !prompt) return;
    event.preventDefault();
    prompt.prompt();
    await prompt.userChoice.catch(() => null);
    prompt = null;
    mostrar(false);
  });
})();
