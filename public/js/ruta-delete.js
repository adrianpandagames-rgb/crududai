(() => {
  const modal = document.getElementById('rutaDeleteModal');
  const line = document.getElementById('rutaDeleteLine');
  const confirm = document.getElementById('rutaDeleteConfirm');
  let pendingForm = null;

  document.querySelectorAll('.ruta-delete-form').forEach((form) => {
    form.addEventListener('submit', (event) => event.preventDefault());
    form.querySelector('.ruta-delete-open').addEventListener('click', () => {
      pendingForm = form;
      line.textContent = form.dataset.lineNumber;
      modal.showModal();
    });
  });

  document.getElementById('rutaDeleteCancel').addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => { pendingForm = null; });
  confirm.addEventListener('click', () => {
    if (!pendingForm) return;
    confirm.disabled = true;
    HTMLFormElement.prototype.submit.call(pendingForm);
  });
})();
