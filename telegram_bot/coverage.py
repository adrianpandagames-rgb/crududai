import math
import re
from io import BytesIO
from .api import api_get


def coverage_parameters(args):
    decimal = r'[+-]?\d+(?:\.\d+)?'
    dms = r'''\d{1,3}\s*[°º]\s*\d{1,2}\s*['’′]\s*\d{1,2}(?:\.\d+)?\s*["”″]?\s*[NSEWO]'''
    token = f'(?:{dms}|{decimal})'
    match = re.fullmatch(f'({token})[\\s,;]+({token})(?:\\s+(.*))?', ' '.join(args).strip(), re.IGNORECASE)
    if not match:
        raise ValueError('Uso: /cobertura latitud longitud [azimut] [alcance_m]\nAcepta decimal o DMS con hemisferio. Ejemplo: /cobertura 29°4\'19.2"N, 110°57\'21.6"W 50')

    def coordinate(value, axis):
        parts = re.fullmatch(r'''(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:\.\d+)?)\s*["”″]?\s*([NSEWO])''', value, re.IGNORECASE)
        if not parts:
            return float(value)
        degrees, minutes, seconds, direction = parts.groups()
        direction = direction.upper()
        if float(minutes) >= 60 or float(seconds) >= 60 or direction not in ('NS' if axis == 'lat' else 'EWO'):
            raise ValueError('DMS inválido: verifica minutos, segundos y hemisferio.')
        result = float(degrees) + float(minutes) / 60 + float(seconds) / 3600
        return -result if direction in 'SWO' else result

    options = (match[3] or '').split()
    positional = []
    named = {}
    while options:
        value = options.pop(0)
        if value in ('--azimut', '--azimuth', '--alcance'):
            key = 'radius' if value == '--alcance' else 'azimuth'
            if not options or key in named:
                raise ValueError('Indica un valor para cada opción, sin repetirla.')
            named[key] = options.pop(0)
        else:
            positional.append(value)
    if len(positional) > 2 or (positional and 'azimuth' in named) or (len(positional) == 2 and 'radius' in named):
        raise ValueError('Usa [azimut] [alcance_m] o las opciones --azimut y --alcance sin repetir valores.')
    try:
        lat, lng = coordinate(match[1], 'lat'), coordinate(match[2], 'lng')
        raw_azimuth = positional[0] if positional else named.get('azimuth')
        azimuth = float(raw_azimuth.rstrip('°')) if raw_azimuth is not None else None
        radius = float(positional[1] if len(positional) == 2 else named.get('radius', 500))
    except ValueError:
        raise ValueError('Usa números separados por espacios, con punto decimal.') from None
    if not all(math.isfinite(value) for value in (lat, lng, radius)) or not (
        -85 <= lat <= 85 and -180 <= lng <= 180 and (azimuth is None or math.isfinite(azimuth) and 0 <= azimuth < 360) and 1 <= radius <= 10000
    ):
        raise ValueError('Latitud: -85 a 85; longitud: -180 a 180; azimut: 0 a menos de 360; alcance: 1 a 10000 m.')
    parameters = {'lat': format(lat, '.10f'), 'lng': format(lng, '.10f'), 'radius': format(radius, '.10f')}
    if azimuth is not None:
        parameters['azimuth'] = format(azimuth, '.10f')
    return parameters


async def coverage_image(client, parameters, user_id):
    response = await api_get(client, 'api/bot/cobertura', params=parameters,
                                headers={'X-Telegram-User-Id': str(user_id)}, timeout=60)
    response.raise_for_status()
    image = response.content
    if not response.headers.get('content-type', '').startswith('image/png') or not image.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Respuesta de imagen inválida.')
    return image


async def coverage_geocoding(client, parameters, user_id):
    # This POST explicitly requests geocoding and persistence; no automatic retry.
    response = await client.post('api/bot/cobertura/ubicacion',
                                 json={'lat': parameters['lat'], 'lng': parameters['lng']},
                                 headers={'X-Telegram-User-Id': str(user_id)}, timeout=60)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get('rows'), list) or any(not isinstance(row, dict) for row in data['rows']):
        raise ValueError('Respuesta de geocoding inválida.')
    return data


async def send_coverage(message, image, parameters):
    photo = BytesIO(image)
    photo.name = 'cobertura-antena.png'
    details = (f"Azimut: {float(parameters['azimuth']):g}° · Alcance: {float(parameters['radius']):g} m\n"
               'Sector de ±45°. Cobertura ilustrativa.') if 'azimuth' in parameters else 'Sin azimut: se muestra únicamente la ubicación de la antena.'
    await message.reply_photo(photo=photo, caption=(
        f"Antena: {float(parameters['lat']):g}, {float(parameters['lng']):g}\n"
        + details), protect_content=True)
