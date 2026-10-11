(() => {
  const modal = document.getElementById('editLocationModal');
  const form = document.getElementById('editLocationForm');
  const save = document.getElementById('editLocationSave');
  const cancel = document.getElementById('editLocationCancel');
  const error = document.getElementById('editLocationError');
  let saving = false;
  document.addEventListener('click', event => {
    const button = event.target.closest('.edit-location-btn');
    if (!button) return;
    form.action = '/ubicaciones/' + encodeURIComponent(button.dataset.id) + '/modificar';
    form.elements.coordinates.value = button.dataset.latitude + ', ' + button.dataset.longitude;
    form.elements.ubicacion.value = button.dataset.ubicacion;
    form.elements.lugar.value = button.dataset.lugar;
    error.hidden = true;
    modal.showModal();
  });
  cancel.addEventListener('click', () => modal.close());
  modal.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    save.disabled = cancel.disabled = true;
    error.hidden = true;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No se pudo guardar la ubicación.');
      const url = new URL(window.location.href);
      url.searchParams.set('message', 'Ubicación modificada con éxito.');
      url.searchParams.set('type', 'success');
      window.location.href = url.href;
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      saving = false;
      save.disabled = cancel.disabled = false;
    }
  });
})();
