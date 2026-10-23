import asyncio
import re

USERNAME = re.compile(r'@?([A-Za-z0-9_][A-Za-z0-9._-]{0,63})')
MODES = {'rapida': 'rápida, 100 sitios', 'normal': 'normal, 500 sitios'}
POLL_SECONDS = 15
# Searches wait in the shared queue before running, so the bot follows them longer than Maigret's own limit.
MAX_WAIT_SECONDS = {'rapida': 25 * 60, 'normal': 45 * 60}
MESSAGE_LIMIT = 3500


def maigret_arguments(args):
    args = list(args or [])
    mode = 'rapida'
    if '--normal' in args:
        args.remove('--normal')
        mode = 'normal'
    if len(args) != 1:
        raise ValueError('Uso: /maigret usuario [--normal]\nEjemplo: /maigret guero_hmo')
    match = USERNAME.fullmatch(args[0])
    if not match:
        raise ValueError('El usuario solo puede tener letras, números, punto, guion o guion bajo, sin espacios.')
    return match.group(1), mode


def maigret_messages(data):
    username = data.get('username', '')
    total = data.get('total', 0)
    if data.get('status') == 'error':
        return [f"La búsqueda de @{username} no pudo completarse: {data.get('error') or 'error desconocido'}"]
    lines = [f'Maigret @{username}: {total} cuenta(s) encontrada(s).']
    if data.get('error'):
        lines.append(str(data['error']))
    current = None
    for account in data['accounts']:
        if account.get('username') != current:
            current = account.get('username')
            if current != username:
                lines.append(f'\nAlias encontrado: @{current}')
        similar = ' (aproximada)' if account.get('similar') else ''
        lines.append(f"• {account.get('site')}: {account.get('url') or 'sin liga'}{similar}")
    if total > len(data['accounts']):
        lines.append(f"\nSe muestran {len(data['accounts'])} de {total}; consulta el resto en la web.")
    if total:
        lines.append('\nUna cuenta con el mismo nombre no confirma que sea la misma persona: verifica cada perfil.')
    if data.get('web_url'):
        lines.append(f"Detalle: {data['web_url']}")
    messages, current_message = [], ''
    for line in lines:
        if current_message and len(current_message) + len(line) + 1 > MESSAGE_LIMIT:
            messages.append(current_message)
            current_message = ''
        current_message = f'{current_message}\n{line}' if current_message else line[:MESSAGE_LIMIT]
    return messages + [current_message]


async def follow_search(search_id, mode, get_status, send_text, send_report, sleep=asyncio.sleep):
    """Polls the search until it finishes and delivers the result to the chat."""
    waited = 0
    while waited < MAX_WAIT_SECONDS[mode]:
        await sleep(POLL_SECONDS)
        waited += POLL_SECONDS
        try:
            data = await get_status(search_id)
        except Exception:
            # A transient API failure should not abandon a search that keeps running on the server.
            continue
        if data['status'] in ('pendiente', 'procesando'):
            continue
        for message in maigret_messages(data):
            await send_text(message)
        if data['status'] == 'listo' and data.get('has_report'):
            await send_report(search_id, data.get('username', 'usuario'))
        return data['status']
    await send_text('La búsqueda sigue en proceso después de mucho tiempo. Consulta el resultado en la pestaña Maigret del sistema.')
    return 'timeout'
