(() => {
  const input = document.getElementById('archivo');
  const zone = document.getElementById('rutaDropZone');
  const status = document.getElementById('rutaDropStatus');
  let dragDepth = 0;

  input.addEventListener('change', () => {
    status.textContent = input.files[0] ? 'Archivo seleccionado: ' + input.files[0].name : '';
  });

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((type) => {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (type === 'dragenter') dragDepth++;
      if (type === 'dragover') event.dataTransfer.dropEffect = 'copy';
      if (type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
      if (type === 'drop') {
        dragDepth = 0;
        const files = event.dataTransfer.files;
        if (files.length !== 1 || !/\.(csv|xlsx)$/i.test(files[0].name)) {
          status.textContent = 'Suelta un solo archivo CSV o Excel (.xlsx).';
        } else {
          input.files = files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      zone.classList.toggle('is-dragging', dragDepth > 0);
    });
  });
})();
