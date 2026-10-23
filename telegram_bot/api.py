import os
import asyncio
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
                             verify=context, timeout=httpx.Timeout(60, connect=10, pool=10),
                             limits=httpx.Limits(max_keepalive_connections=0),
                             follow_redirects=False, trust_env=False)


async def api_get(client, path, **kwargs):
    # Retry only read-only requests interrupted before receiving a response.
    for attempt in range(2):
        try:
            return await client.get(path, **kwargs)
        except (httpx.ReadError, httpx.RemoteProtocolError):
            if attempt:
                raise
            await asyncio.sleep(0.3)


async def start_maigret(client, username, mode, user_id):
    # Starting a search is not idempotent, so it is never retried.
    response = await client.post('api/bot/maigret', json={'usuario': username, 'modo': mode},
                                 headers={'X-Telegram-User-Id': str(user_id)})
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get('id'), str):
        raise ValueError('Respuesta de API inválida.')
    return data


async def maigret_status(client, search_id, user_id):
    response = await api_get(client, f'api/bot/maigret/{search_id}', headers={'X-Telegram-User-Id': str(user_id)})
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get('status'), str) or not isinstance(data.get('accounts'), list):
        raise ValueError('Respuesta de API inválida.')
    return data


async def maigret_report(client, search_id, user_id):
    response = await api_get(client, f'api/bot/maigret/{search_id}/reporte', headers={'X-Telegram-User-Id': str(user_id)})
    response.raise_for_status()
    return response.content


async def search_api(client, command, term, page, user_id):
    if command not in ('linea', 'imei', 'antena'):
        raise ValueError('Comando desconocido.')
    response = await api_get(client, f'api/bot/{command}', params={'q': term, 'page': page},
                                headers={'X-Telegram-User-Id': str(user_id)})
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get('rows'), list) or not isinstance(data.get('has_more'), bool):
        raise ValueError('Respuesta de API inválida.')
    if (command != 'linea' and len(data['rows']) > 5) or any(not isinstance(row, dict) for row in data['rows']):
        raise ValueError('Resultados de API inválidos.')
    return data
