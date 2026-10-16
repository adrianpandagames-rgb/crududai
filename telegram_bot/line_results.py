from io import BytesIO
from .core import format_row


async def send_line_results(message, rows):
    if not rows:
        await message.reply_text('No hay coincidencias para esa línea.')
        return
    text = f'Resultados: {len(rows)}\n\n' + '\n\n'.join(format_row('linea', row) for row in rows)
    if len(text) <= 3800:
        await message.reply_text(text, protect_content=True)
    else:
        # Un archivo permite entregar todas las coincidencias sin saturar el chat.
        document = BytesIO(text.encode('utf-8'))
        await message.reply_document(document=document, filename='resultados-linea.txt',
                                     caption=f'{len(rows)} coincidencias. El archivo contiene todos los resultados.',
                                     protect_content=True)
