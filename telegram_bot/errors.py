import httpx


def api_error_details(error):
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        messages = {
            400: 'La API rechazó el formato de la consulta. Revisa /ayuda.',
            401: 'La API rechazó la credencial del bot. Revisa TELEGRAM_API_TOKEN y reinicia Node y el bot.',
            403: 'La API no autoriza tu ID. Revisa TELEGRAM_ALLOWED_USER_IDS y reinicia Node y el bot.',
            404: 'La ruta de consulta no está disponible. Revisa la URL de la API y reinicia Node con la versión actual.',
            503: 'El servicio de consultas no está disponible. Revisa la configuración de la API y la conexión MySQL de Node.',
        }
        return f'HTTP_{status}', messages.get(status, 'La API del sistema devolvió un error. Intenta más tarde.')
    if isinstance(error, httpx.TimeoutException):
        return 'API_TIMEOUT', 'La API tardó demasiado en responder. Revisa el servidor Node y su conexión MySQL.'
    if isinstance(error, httpx.ConnectError):
        return 'API_CONNECTION', 'No se pudo conectar con la API. Revisa que Node esté iniciado, la URL y el certificado HTTPS.'
    if isinstance(error, (httpx.ReadError, httpx.RemoteProtocolError)):
        return 'API_READ_INTERRUPTED', 'Se interrumpió la conexión con Node al recibir la respuesta. Intenta nuevamente y verifica que Node siga iniciado.'
    return type(error).__name__, 'No se pudo consultar la API del sistema. Intenta más tarde.'
