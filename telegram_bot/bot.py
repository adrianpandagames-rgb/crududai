import logging
import os
import time
from pathlib import Path

from .api import create_client, search_api
from .line_results import send_line_results
from .errors import api_error_details
from .command_aliases import line_alias_handler
from .core import PAGE_SIZE, allowed_user_ids, can_query, format_row, query_for
from .coverage import coverage_parameters, coverage_image, send_coverage, coverage_geocoding

HELP = ('Consultas disponibles:\n'
        '/cobertura 29.0729 -110.9559 — solo antena, sin azimut\n'
        '/cobertura 29°4\'19.2"N, 110°57\'21.6"W 50 — también acepta DMS\n'
        'Azimut y alcance opcionales. Usa --alcance 1000 para indicar solo el alcance.\n'
        '/cobertura 29.0729 -110.9559 50 — imagen de antena, alcance 500 m\n'
        '/cobertura 29.0729 -110.9559 50 1000 — alcance opcional en metros\n'
        '/linea 6621234567 — todas las coincidencias de la línea o contacto\n'
        '/línea 6621234567 — también acepta el comando con tilde\n'
        '/imei 123456789012345 — IMEI registrado\n'
        '/antena Hermosillo — dirección o lugar en ubicaciones\n'
        '/antena 29.072,-110.956 — coordenadas exactas\n'
        '/antena 29.072 -110.956 — decimal separado por espacio\n'
        '/antena 29°4\u002719.2\u0022N, 110°57\u002721.6\u0022W — coordenadas DMS\n'
        'En IMEI y antenas, para más resultados añade: --pagina 2\n'
        '/miid — ver tu ID de Telegram')
logger = logging.getLogger(__name__)


def main():
    from dotenv import load_dotenv
    from telegram import BotCommand
    from telegram.ext import Application, CommandHandler
    from telegram.request import HTTPXRequest

    load_dotenv(Path(__file__).resolve().parents[1] / '.env')
    token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
    if not token:
        raise SystemExit('Configura TELEGRAM_BOT_TOKEN en .env antes de iniciar el bot.')
    try:
        allowed_ids = allowed_user_ids(os.getenv('TELEGRAM_ALLOWED_USER_IDS', ''))
    except ValueError as error:
        raise SystemExit(str(error)) from None
    logging.basicConfig(level=logging.WARNING, format='%(levelname)s %(name)s: %(message)s')
    last_query = {}
    try:
        api_client = create_client()
    except (ValueError, OSError) as error:
        raise SystemExit('Revisa la URL, el token y el certificado de la API del bot.') from None

    async def authorized(update):
        if not update.effective_message or not update.effective_chat or not update.effective_user:
            return False
        if update.effective_chat.type != 'private':
            await update.effective_message.reply_text('Utiliza el bot en un chat privado.')
            return False
        if not can_query(update.effective_chat.type, update.effective_user.id, allowed_ids):
            await update.effective_message.reply_text('No tienes autorización para consultar. Solicita acceso al administrador.')
            return False
        return True

    async def help_command(update, context):
        if await authorized(update):
            await update.effective_message.reply_text(HELP)

    async def my_id(update, context):
        if update.effective_chat and update.effective_chat.type == 'private' and update.effective_user and update.effective_message:
            await update.effective_message.reply_text(f'Tu ID de Telegram: {update.effective_user.id}')

    def search_handler(command):
        async def search(update, context):
            if not await authorized(update):
                return
            user_id = update.effective_user.id
            now = time.monotonic()
            if now - last_query.get(user_id, float('-inf')) < 2:
                await update.effective_message.reply_text('Espera dos segundos entre consultas.')
                return
            try:
                term, page = query_for(command, context.args)
                if command == 'linea':
                    page = 1
            except ValueError as error:
                await update.effective_message.reply_text(str(error))
                return
            last_query[user_id] = now
            try:
                data = await search_api(api_client, command, term, page, user_id)
                rows = data['rows']
            except Exception as error:
                code, message = api_error_details(error)
                logger.error('Consulta fallida: comando=%s usuario=%s codigo=%s', command, user_id, code)
                await update.effective_message.reply_text(message)
                return
            if command == 'linea':
                await send_line_results(update.effective_message, rows)
                return
            if not rows:
                await update.effective_message.reply_text('No hay coincidencias en esta página.')
                return
            for row in rows[:PAGE_SIZE]:
                await update.effective_message.reply_text(format_row(command, row), protect_content=True)
            if data['has_more']:
                await update.effective_message.reply_text(f'Siguiente página: /{command} {term} --pagina {page + 1}')
        return search

    async def coverage_command(update, context):
        if not await authorized(update):
            return
        user_id = update.effective_user.id
        now = time.monotonic()
        if now - last_query.get(user_id, float('-inf')) < 2:
            await update.effective_message.reply_text('Espera dos segundos entre consultas.')
            return
        try:
            parameters = coverage_parameters(context.args)
        except ValueError as error:
            await update.effective_message.reply_text(str(error))
            return
        last_query[user_id] = now
        await update.effective_message.reply_text('Generando mapa de cobertura…')
        stage = 'consulta_antena'
        try:
            term = f"{parameters['lat']} {parameters['lng']}"
            data = await search_api(api_client, 'antena', term, 1, user_id)
            has_more = data['has_more']
            if not data['rows']:
                stage = 'geocoding_ubicacion'
                await update.effective_message.reply_text('Antena no registrada, Realizando geocoding, espere un momento…')
                try:
                    data = await coverage_geocoding(api_client, parameters, user_id)
                except Exception as error:
                    code, _ = api_error_details(error)
                    logger.error('Geocoding fallido: usuario=%s codigo=%s', user_id, code)
                    await update.effective_message.reply_text('No fue posible obtener o guardar la dirección en Geocoding. Se generará el mapa con las coordenadas indicadas.')
                    data = {'rows': [], 'status': 'ERROR'}
            stage = 'envio_datos_telegram'
            for row in data['rows']:
                await update.effective_message.reply_text(format_row('antena', row), protect_content=True)
            if not data['rows'] and data.get('status') != 'ERROR':
                await update.effective_message.reply_text('Geocoding no encontró una dirección para esas coordenadas. Se generará el mapa con la ubicación indicada.')
            if has_more:
                await update.effective_message.reply_text(f'Más registros: /antena {term} --pagina 2')
            stage = 'descarga_imagen_node'
            image = await coverage_image(api_client, parameters, user_id)
            stage = 'envio_imagen_telegram'
            await send_coverage(update.effective_message, image, parameters)
        except Exception as error:
            code, message = api_error_details(error)
            logger.error('Mapa fallido: usuario=%s etapa=%s codigo=%s', user_id, stage, code)
            await update.effective_message.reply_text(message)

    async def post_init(application):
        await application.bot.set_my_commands([
            BotCommand('linea', 'Consultar una línea'),
            BotCommand('imei', 'Consultar un IMEI'),
            BotCommand('antena', 'Consultar ubicacion de antena'),
            BotCommand('cobertura', 'Mapa de antena: latitud longitud azimut'),
            BotCommand('ayuda', 'Ver comandos y ejemplos'),
            BotCommand('miid', 'Ver tu ID de Telegram'),
        ])

    async def on_error(update, context):
        # No registrar objetos Update ni errores HTTP: pueden contener datos o el token.
        from telegram.error import TimedOut
        if isinstance(context.error, TimedOut):
            logger.error('Telegram no respondió dentro del tiempo de espera; no se pudo confirmar la operación.')
            return
        logger.error('Error del bot: %s', type(context.error).__name__)

    async def post_shutdown(application):
        await api_client.aclose()

    # The environment proxy times out for Telegram; use the verified direct route.
    def telegram_request():
        return HTTPXRequest(connect_timeout=30, read_timeout=60, write_timeout=60, pool_timeout=10,
                            httpx_kwargs={'trust_env': False})

    application = (Application.builder().token(token)
                   .request(telegram_request()).get_updates_request(telegram_request())
                   .post_init(post_init).post_shutdown(post_shutdown).build())
    application.add_handler(CommandHandler(['start', 'ayuda', 'help'], help_command))
    application.add_handler(CommandHandler('miid', my_id))
    application.add_handler(CommandHandler('cobertura', coverage_command))
    for command in ('linea', 'imei', 'antena'):
        application.add_handler(CommandHandler(command, search_handler(command)))
    application.add_handler(line_alias_handler(search_handler('linea')))
    application.add_error_handler(on_error)
    from telegram.error import NetworkError
    try:
        application.run_polling(allowed_updates=['message'], drop_pending_updates=True, bootstrap_retries=3)
    except NetworkError:
        raise SystemExit('No fue posible conectar con Telegram después de los reintentos. Revisa la conexión a Internet y el acceso a api.telegram.org:443.') from None


if __name__ == '__main__':
    main()
