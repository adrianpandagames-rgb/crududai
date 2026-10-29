// Shows a loading bar from the moment a link or form starts a navigation until the next page arrives.
(() => {
  const root = document.documentElement;
  let bar;
  let fallback;

  const stop = () => {
    clearTimeout(fallback);
    root.classList.remove('is-navigating');
  };

  const start = () => {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'page-progress';
      bar.setAttribute('aria-hidden', 'true');
      document.body.appendChild(bar);
      void bar.offsetWidth; // Let the bar render hidden first so its animation starts from zero.
    }
    root.classList.add('is-navigating');
    // Downloads and server errors keep the current page; do not leave the bar running forever.
    clearTimeout(fallback);
    fallback = setTimeout(stop, 8000);
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.target && link.target !== '_self') return;
    if (link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    // Same page, different hash: the browser only scrolls.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    start();
  });

  // Runs after other submit handlers (confirmation dialogs) have had their chance to cancel.
  window.addEventListener('submit', (event) => {
    const form = event.target;
    if (event.defaultPrevented || (form.target && form.target !== '_self')) return;
    start();
  });

  // Coming back through the back/forward cache restores the page with the bar still showing.
  window.addEventListener('pageshow', stop);
})();
