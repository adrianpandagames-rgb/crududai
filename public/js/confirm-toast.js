// Confirmation shown as a toast inside the page, in place of the browser's confirm() dialog.
// Forms opt in with data-confirm="¿Pregunta?"; data-confirm-action names the button (default "Eliminar")
// and data-confirm-tone="primary" makes it blue for actions that do not delete anything.
// Scripts can also call: if (await window.confirmToast('¿Pregunta?', { action: 'Guardar' })) { ... }
(() => {
  if (window.confirmToast) return;
  let pending = null;

  const close = (answer) => {
    if (!pending) return;
    const { element, resolve, previousFocus } = pending;
    pending = null;
    element.classList.remove('is-visible');
    setTimeout(() => element.remove(), 200);
    previousFocus?.focus?.({ preventScroll: true });
    resolve(answer);
  };

  window.confirmToast = (message, { action = 'Eliminar', tone = 'danger' } = {}) => new Promise((resolve) => {
    close(false);
    const element = document.createElement('div');
    element.className = 'confirm-toast';
    element.setAttribute('role', 'alertdialog');
    element.setAttribute('aria-live', 'assertive');
    const icon = document.createElement('i');
    icon.className = `bi ${tone === 'primary' ? 'bi-question-circle-fill' : 'bi-exclamation-triangle-fill'} confirm-toast-icon`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('p');
    text.className = 'confirm-toast-message';
    text.id = `confirm-toast-${Date.now()}`;
    text.textContent = message;
    element.setAttribute('aria-describedby', text.id);
    const buttons = document.createElement('div');
    buttons.className = 'confirm-toast-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm btn-light';
    cancel.textContent = 'Cancelar';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = `btn btn-sm ${tone === 'primary' ? 'btn-primary' : 'btn-danger'}`;
    accept.textContent = action;
    cancel.addEventListener('click', () => close(false));
    accept.addEventListener('click', () => close(true));
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(false); }
      // Keep the keyboard inside the toast while it waits for an answer.
      if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === cancel ? accept : cancel).focus();
      }
    });
    buttons.append(cancel, accept);
    element.append(icon, text, buttons);
    // In fullscreen (e.g. the Planeación map) only the fullscreen element is visible.
    (document.fullscreenElement || document.body).append(element);
    pending = { element, resolve, previousFocus: document.activeElement };
    requestAnimationFrame(() => element.classList.add('is-visible'));
    // "Cancelar" gets the focus, so pressing Enter by mistake never deletes anything.
    cancel.focus({ preventScroll: true });
  });

  // Capture phase: runs before any handler the page attached to the form itself.
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) return;
    if (form.dataset.confirmed === '1') {
      delete form.dataset.confirmed;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const { submitter } = event;
    const confirmed = await window.confirmToast(form.dataset.confirm, {
      action: form.dataset.confirmAction || 'Eliminar',
      tone: form.dataset.confirmTone || 'danger',
    });
    if (!confirmed) return;
    form.dataset.confirmed = '1';
    if (form.requestSubmit) form.requestSubmit(submitter && form.contains(submitter) ? submitter : undefined);
    else form.submit();
  }, true);
})();
