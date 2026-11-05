import asyncio

MODES = {'rapida': 'rápida, hasta 15 minutos', 'normal': 'normal, hasta 1 hora'}
# The first word may name the kind of target; otherwise the server guesses it from the text.
TYPES = {
    'dominio': 'dominio', 'ip': 'ip', 'red': 'red', 'asn': 'asn', 'correo': 'correo', 'email': 'correo',
    'telefono': 'telefono', 'teléfono': 'telefono', 'usuario': 'usuario', 'nombre': 'nombre', 'bitcoin': 'bitcoin',
}
USAGE = ('Uso: /spiderfoot objetivo [--normal]\n'
         'Ejemplos: /spiderfoot ejemplo.com · /spiderfoot 189.203.10.5 · /spiderfoot nombre@gmail.com\n'
         '/spiderfoot +52 6621234567 · /spiderfoot @guero_hmo · /spiderfoot Juan Pérez López\n'
         'Para indicar el tipo: /spiderfoot usuario juan.perez (dominio, ip, red, asn, correo, telefono, usuario, nombre, bitcoin)')
POLL_SECONDS = 30
# Searches wait in their own queue before running, so the bot follows them well past SpiderFoot's own limit.
MAX_WAIT_SECONDS = {'rapida': 90 * 60, 'normal': 3 * 60 * 60}
MESSAGE_LIMIT = 3500


def spiderfoot_arguments(args):
    args = list(args or [])
    mode = 'rapida'
    if '--normal' in args:
        args.remove('--normal')
        mode = 'normal'
    kind = None
    if len(args) > 1 and args[0].lower() in TYPES:
        kind = TYPES[args[0].lower()]
        args = args[1:]
    target = ' '.join(args).strip()
    if not target or len(target) > 255:
        raise ValueError(USAGE)
    return kind, target, mode


def split_messages(lines):
    messages, current = [], ''
    for line in lines:
        if current and len(current) + len(line) + 1 > MESSAGE_LIMIT:
            messages.append(current)
            current = ''
        current = f'{current}\n{line}' if current else line[:MESSAGE_LIMIT]
    return messages + [current]


def spiderfoot_messages(data):
    target = data.get('target', '')
    if data.get('status') == 'error':
        return [f"La búsqueda de {target} no pudo completarse: {data.get('error') or 'error desconocido'}"]
    total = data.get('total', 0)
    lines = [f"SpiderFoot {target} ({data.get('type_label', '')}): {total} resultado(s)."]
    lines += [str(note) for note in data.get('notes') or []]
    for category in data.get('categories') or []:
        lines.append(f"\n{category.get('label')} ({category.get('total')})")
        for group in category.get('types') or []:
            lines.append(f"• {group.get('label')}: {group.get('count')}")
            lines += [f'   – {example}' for example in group.get('examples') or []]
            hidden = group.get('count', 0) - len(group.get('examples') or [])
            if group.get('examples') and hidden > 0:
                lines.append(f'   … y {hidden} más')
    if total:
        lines.append('\nSon coincidencias en fuentes públicas: verifica cada dato antes de usarlo. El CSV trae todos los resultados.')
    if data.get('web_url'):
        lines.append(f"Detalle: {data['web_url']}")
    return split_messages(lines)


async def follow_spiderfoot(search_id, mode, get_status, send_text, send_csv, sleep=asyncio.sleep):
    """Polls the search until it finishes and delivers the summary and the CSV to the chat."""
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
        for message in spiderfoot_messages(data):
            await send_text(message)
        if data['status'] == 'listo' and data.get('total'):
            await send_csv(search_id, data.get('target', 'objetivo'))
        return data['status']
    await send_text('La búsqueda sigue en proceso después de mucho tiempo. Consulta el resultado en la pestaña SpiderFoot del sistema.')
    return 'timeout'
