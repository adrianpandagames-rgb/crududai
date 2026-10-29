// Success messages the server renders after saving ("Ubicación registrada con éxito.") fade out after 3 seconds.
// Only the ones present when the page loads: messages that scripts write later, such as a registration's folio,
// stay so they can be read and copied, and errors stay until the page changes. data-persistente opts a message out.
(() => {
  const VISIBLE_MS = 3000;
  const FADE_MS = 300;
  const start = () => {
    const messages = document.querySelectorAll('.alert.alert-success:not([data-persistente])');
    if (!messages.length) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => messages.forEach((message) => {
      if (reduceMotion) {
        message.remove();
        return;
      }
      // Fades and closes the gap it leaves, so the content below slides up instead of jumping.
      message.style.overflow = 'hidden';
      message.style.maxHeight = `${message.offsetHeight}px`;
      message.style.transition = `opacity ${FADE_MS}ms ease-out, max-height ${FADE_MS}ms ease-out, margin ${FADE_MS}ms ease-out, padding ${FADE_MS}ms ease-out`;
      requestAnimationFrame(() => {
        Object.assign(message.style, { opacity: '0', maxHeight: '0', marginTop: '0', marginBottom: '0', paddingTop: '0', paddingBottom: '0' });
      });
      setTimeout(() => message.remove(), FADE_MS);
    }), VISIBLE_MS);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
