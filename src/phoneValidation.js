import https from "https";

const PHONE_VALIDATION_API_URL = 'https://apilayer.net/api/validate';

const normalizePhoneNumber = (value) => String(value || '').replace(/\D/g, '');

const requestPhoneValidation = (url) => new Promise((resolve, reject) => {
  const request = https.get(url, { headers: { Accept: 'application/json' }, timeout: 10000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        resolve({ statusCode: response.statusCode, data: JSON.parse(body) });
      } catch {
        reject(new Error('La respuesta del servicio no tiene un formato válido.'));
      }
    });
  });

  request.on('timeout', () => request.destroy(new Error('La consulta telefónica tardó demasiado.')));
  request.on('error', reject);
});

const validatePhoneNumber = async (rawNumber) => {
  const digits = normalizePhoneNumber(rawNumber);
  if (digits.length < 7 || digits.length > 15) {
    const error = new Error('Ingresa un número telefónico de 7 a 15 dígitos, incluyendo el código de país.');
    error.status = 400;
    throw error;
  }

  const accessKey = process.env.PHONE_VALIDATION_ACCESS_KEY;
  if (!accessKey) {
    const error = new Error('La consulta telefónica no está configurada en el servidor.');
    error.status = 503;
    throw error;
  }

  const query = new URLSearchParams({
    access_key: accessKey,
    number: `+${digits}`,
    country_code: '',
    format: '1',
  });
  try {
    const { statusCode, data } = await requestPhoneValidation(`${PHONE_VALIDATION_API_URL}?${query.toString()}`);

    if (statusCode < 200 || statusCode >= 300 || !data) {
      const error = new Error('El servicio de validación telefónica no respondió correctamente.');
      error.status = 502;
      throw error;
    }

    return data;
  } catch (cause) {
    if (cause.status) throw cause;
    const error = new Error(cause.name === 'AbortError'
      ? 'La consulta telefónica tardó demasiado. Intenta nuevamente.'
      : 'No fue posible consultar el servicio de validación telefónica.');
    error.status = 502;
    throw error;
  }
};

export { validatePhoneNumber };
