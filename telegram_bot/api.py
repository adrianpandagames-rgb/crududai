import os
import ssl
from pathlib import Path
from urllib.parse import urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]


def create_client():
    base = os.getenv('TELEGRAM_API_BASE_URL', 'https://localhost:3443').rstrip('/')
    url = urlsplit(base)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('TELEGRAM_API_BASE_URL debe ser una URL HTTPS sin credenciales.')
    token = os.getenv('TELEGRAM_API_TOKEN', '')
    if len(token) < 32:
        raise ValueError('Configura TELEGRAM_API_TOKEN con al menos 32 caracteres.')
    context = ssl.create_default_context()
    certificate = os.getenv('TELEGRAM_API_CA_CERT', '').strip()
    if certificate:
        path = Path(certificate)
        context.load_verify_locations(cafile=str(path if path.is_absolute() else ROOT / path))
    return httpx.AsyncClient(base_url=base + '/', headers={'Authorization': f'Bearer {token}'},
                             verify=context, timeout=15, follow_redirects=False, trust_env=False)


async def search_api(client, command, term, page, user_id):
    if command not in ('linea', 'imei', 'antena'):
        raise ValueError('Comando desconocido.')
    response = await client.get(f'api/bot/{command}', params={'q': term, 'page': page},
                                headers={'X-Telegram-User-Id': str(user_id)})
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get('rows'), list) or not isinstance(data.get('has_more'), bool):
        raise ValueError('Respuesta de API inválida.')
    if (command != 'linea' and len(data['rows']) > 5) or any(not isinstance(row, dict) for row in data['rows']):
        raise ValueError('Resultados de API inválidos.')
    return data
