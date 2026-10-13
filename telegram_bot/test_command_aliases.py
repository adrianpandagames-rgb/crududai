import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from telegram import Chat, Message, Update
from .command_aliases import line_alias_handler


class AliasTests(unittest.IsolatedAsyncioTestCase):
    async def test_accented_command_reaches_the_same_search_with_arguments(self):
        for text in ['/línea 6621234567', '/LÍNEA 6621234567', '/li\u0301nea 6621234567', '/línea@CrudBot 6621234567']:
            callback = AsyncMock()
            handler = line_alias_handler(callback)
            update = Update(1, message=Message(1, datetime.now(timezone.utc), Chat(123, 'private'), text=text))
            context = SimpleNamespace(bot=SimpleNamespace(username='CrudBot'))
            self.assertTrue(handler.check_update(update))
            await handler.callback(update, context)
            callback.assert_awaited_once_with(update, context)
            self.assertEqual(context.args, ['6621234567'])

    async def test_commands_addressed_to_another_bot_are_ignored(self):
        callback = AsyncMock()
        handler = line_alias_handler(callback)
        update = SimpleNamespace(effective_message=SimpleNamespace(text='/línea@OtherBot 6621234567'))
        await handler.callback(update, SimpleNamespace(bot=SimpleNamespace(username='CrudBot')))
        callback.assert_not_awaited()
