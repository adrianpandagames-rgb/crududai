import logging
import os
import time
from pathlib import Path

from .api import create_client, search_api
from .line_results import send_line_results
from .errors import api_error_details
from .command_aliases import line_alias_handler
from .core import PAGE_SIZE, allowed_user_ids, can_query, format_row, query_for

HELP = ('Consultas disponibles:\n'
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

    async def post_init(application):
        await application.bot.set_my_commands([
            BotCommand('linea', 'Consultar una línea'),
            BotCommand('imei', 'Consultar un IMEI'),
            BotCommand('antena', 'Consultar ubicacion de antena'),
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

    application = (Application.builder().token(token)
                   .connect_timeout(10).read_timeout(60).write_timeout(60).pool_timeout(10)
                   .get_updates_connect_timeout(10).get_updates_read_timeout(60)
                   .post_init(post_init).post_shutdown(post_shutdown).build())
    application.add_handler(CommandHandler(['start', 'ayuda', 'help'], help_command))
    application.add_handler(CommandHandler('miid', my_id))
    for command in ('linea', 'imei', 'antena'):
        application.add_handler(CommandHandler(command, search_handler(command)))
    application.add_handler(line_alias_handler(search_handler('linea')))
    application.add_error_handler(on_error)
    application.run_polling(allowed_updates=['message'], drop_pending_updates=True)


if __name__ == '__main__':
    main()
