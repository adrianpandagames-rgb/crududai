import re
import unicodedata

from telegram.ext import MessageHandler, filters


def line_alias_handler(callback):
    # Telegram's CommandHandler accepts ASCII commands only. Read the accented
    # alias as text and dispatch it through the same authorized search callback.
    async def accented_line(update, context):
        text = unicodedata.normalize('NFC', update.effective_message.text or '')
        match = re.fullmatch(r'/línea(?:@([a-zA-Z0-9_]+))?(?:\s+(.*))?', text, re.IGNORECASE | re.DOTALL)
        if not match:
            return
        target, arguments = match.groups()
        if target and target.lower() != (context.bot.username or '').lower():
            return
        context.args = (arguments or '').split()
        await callback(update, context)

    return MessageHandler(filters.TEXT & filters.Regex(re.compile(r'^/l(?:í|i\u0301)nea(?:@\w+)?(?:\s|$)', re.IGNORECASE)), accented_line)
