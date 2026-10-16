import math
import re

PAGE_SIZE = 5


def can_query(chat_type, user_id, allowed_ids):
    return chat_type == 'private' and user_id in allowed_ids


def allowed_user_ids(value):
    ids = frozenset(int(part.strip()) for part in value.split(',') if part.strip())
    if not ids or any(user_id <= 0 for user_id in ids):
        raise ValueError('Configura TELEGRAM_ALLOWED_USER_IDS con IDs numéricos positivos.')
    return ids


def query_for(command, args):
    if not args:
        raise ValueError(f'Uso: /{command} consulta [--pagina N]')
    args = list(args)
    page = 1
    if '--pagina' in args:
        if len(args) < 3 or args[-2] != '--pagina' or not args[-1].isdigit():
            raise ValueError('Indica la página al final: --pagina 2')
        page = int(args[-1])
        args = args[:-2]
    if not 1 <= page <= 100:
        raise ValueError('La página debe estar entre 1 y 100.')
    term = ' '.join(args).strip()
    if not term or len(term) > 120:
        raise ValueError('La consulta debe contener entre 1 y 120 caracteres.')
    if command == 'linea':
        if not re.fullmatch(r'\+?\d{7,15}', term):
            raise ValueError('Usa el n?mero completo, sin espacios ni guiones.')
    elif command == 'imei':
        if not re.fullmatch(r'\d{14,16}', term):
            raise ValueError('El IMEI debe tener entre 14 y 16 d?gitos.')
    elif command == 'antena':
        coordinate = re.fullmatch(r'([+-]?\d+(?:\.\d+)?)(?:\s*[,;]\s*|\s+)([+-]?\d+(?:\.\d+)?)', term)
        if coordinate:
            lat, lng = map(float, coordinate.groups())
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                raise ValueError('Coordenadas fuera de rango.')
        elif ',' in term and re.match(r'^-?\d', term) and not re.search(r'[°º]', term):
            raise ValueError('Usa latitud longitud o latitud,longitud con punto decimal.')
    else:
        raise ValueError('Comando desconocido.')
    return term, page


def format_row(command, row):
    def value(key):
        return str(row.get(key) if row.get(key) is not None else '—')[:500]
    if command == 'antena':
        if row.get('fuente') == 'geocoding':
            return (f"Antena (Geocoding)\nCoordenadas: {value('latitude')}, {value('longitude')}\n"
                    f"Ubicación: {value('ubicacion')}\nLugar: {value('lugar')}\n"
                    f"Mapa: https://www.google.com/maps?q={value('latitude')},{value('longitude')}")
        result = f"Antena #{value('idUbicacion')}\nCoordenadas: {value('latitude')}, {value('longitude')}\nUbicación: {value('ubicacion')}\nLugar: {value('lugar')}"
        try:
            lat, lng = float(row['latitude']), float(row['longitude'])
            if math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180:
                result += f'\nMapa: https://www.google.com/maps?q={lat},{lng}'
        except (TypeError, ValueError, KeyError):
            pass
        return result
    result = f"Línea: {value('numObjetivo')}\nNUC: {value('nuc')}\nTipo: {value('tipo')}\nAño: {value('ano')}"
    if command == 'linea' and 'numeroConsultado' in row:
        objetivo = row.get('esObjetivo') in (1, True, '1')
        contacto = row.get('esContacto') in (1, True, '1')
        role = 'Objetivo y contacto' if objetivo and contacto else 'Objetivo' if objetivo else 'Contacto' if contacto else 'Sin clasificar'
        result = (f"Número consultado: {value('numeroConsultado')}\nRol: {role}\n"
                  f"Línea objetivo: {value('numObjetivo')}\nNUC: {value('nuc')}\nTipo: {value('tipo')}\nAño: {value('ano')}")
    if command == 'imei':
        result = f"IMEI: {value('imei')}\nMarca: {value('brand_name')}\nModelo: {value('modelo')}\n" + result
    return result
