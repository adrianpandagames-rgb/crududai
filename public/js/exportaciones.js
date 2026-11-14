// Files built in the browser (Coincidencias, Planeación geográfica, the Red telefónica image) never reach the
// server, so each download is reported for the audit log. The download never waits for the report.
window.registrarExportacion = (archivo) => {
  fetch('/auditoria/exportacion', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivo: String(archivo || ''), pagina: window.location.pathname }),
  }).catch(() => {});
};
