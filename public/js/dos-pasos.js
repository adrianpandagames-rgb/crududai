// Passkeys for the second sign-in step: /verificar (signing in) and Mi cuenta (adding one).
// The browser asks the device for the fingerprint, face or PIN; the server only ever sees a signature.
(() => {
  const webauthn = window.SimpleWebAuthnBrowser;
  const soportado = Boolean(webauthn && webauthn.browserSupportsWebAuthn());

  const postJson = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'No fue posible completar la solicitud.');
      error.redirect = data.redirect;
      throw error;
    }
    return data;
  };

  const mensaje = (error) => {
    if (error && error.name === 'NotAllowedError') return 'Se canceló o expiró la verificación. Intenta de nuevo.';
    if (error && error.name === 'InvalidStateError') return 'Este dispositivo ya está registrado en tu cuenta.';
    return (error && error.message) || 'No fue posible completar la verificación.';
  };

  const mostrar = (elemento, texto) => {
    if (!elemento) return;
    elemento.textContent = texto;
    elemento.hidden = !texto;
  };

  // Signing in.
  const verificar = document.getElementById('verificarPasskey');
  if (verificar) {
    const error = document.getElementById('verificarError');
    if (!soportado) {
      verificar.hidden = true;
      const aviso = document.getElementById('verificarSinSoporte');
      if (aviso) aviso.hidden = false;
    }
    verificar.addEventListener('click', async () => {
      verificar.disabled = true;
      mostrar(error, '');
      try {
        const optionsJSON = await postJson('/verificar/opciones');
        const respuesta = await webauthn.startAuthentication({ optionsJSON });
        const { redirect } = await postJson('/verificar/passkey', { respuesta });
        window.location.assign(redirect || '/');
      } catch (fallo) {
        if (fallo.redirect) {
          window.location.assign(fallo.redirect);
          return;
        }
        mostrar(error, mensaje(fallo));
        verificar.disabled = false;
      }
    });
  }

  // Adding a passkey from Mi cuenta.
  const registrar = document.getElementById('registrarPasskey');
  if (registrar) {
    const error = document.getElementById('registrarPasskeyError');
    const boton = registrar.querySelector('button[type="submit"]');
    if (!soportado) {
      boton.disabled = true;
      mostrar(error, 'Este navegador no admite llaves de acceso.');
    }
    registrar.addEventListener('submit', async (event) => {
      event.preventDefault();
      boton.disabled = true;
      mostrar(error, '');
      try {
        const optionsJSON = await postJson('/cuenta/dos-pasos/opciones');
        const respuesta = await webauthn.startRegistration({ optionsJSON });
        await postJson('/cuenta/dos-pasos', { nombre: registrar.elements.nombre.value, respuesta });
        // Same page: the reload shows the new passkey and, for the first one, the recovery codes.
        window.location.hash = 'dos-pasos';
        window.location.reload();
      } catch (fallo) {
        mostrar(error, mensaje(fallo));
        boton.disabled = false;
      }
    });
  }

  // Suggests a name for the device being added.
  const nombre = document.getElementById('passkeyNombre');
  if (nombre && !nombre.value) {
    const ua = navigator.userAgent;
    nombre.value = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Celular Android'
      : /Windows/.test(ua) ? 'PC con Windows' : /Mac/.test(ua) ? 'Mac' : '';
  }
})();
