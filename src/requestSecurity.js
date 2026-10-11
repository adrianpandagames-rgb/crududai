// Forwarded headers are not trusted. Fetch Metadata is set by the browser,
// and permits same-origin forms even when the referrer policy hides their origin.
export function requireSameOrigin(req, res, next) {
  let allowed = false;
  try {
    const origin = req.get('Origin');
    const source = origin && origin !== 'null' ? origin : req.get('Referer');
    const expected = new URL(`${req.protocol}://${req.get('Host')}`).origin;
    if (source) {
      allowed = new URL(source).origin === expected;
    } else {
      allowed = req.get('Sec-Fetch-Site') === 'same-origin';
    }
  } catch {
    return res.status(403).send('Origen de solicitud inválido.');
  }
  if (!allowed) {
    return res.status(403).send('Solicitud de origen no permitido. Abre el formulario desde esta aplicación.');
  }
  // Route errors must reach Express, rather than being reported as origin errors.
  return next();
}
