import unittest
from unittest.mock import AsyncMock
import httpx
from .api import search_api
from .line_results import send_line_results


class LineResultsTests(unittest.IsolatedAsyncioTestCase):
    async def test_more_than_five_results_are_accepted_and_delivered(self):
        rows = [{'numObjetivo': str(index)} for index in range(12)]
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'rows': rows, 'has_more': False}))) as client:
            data = await search_api(client, 'linea', '6621234567', 1, 123)
        message = AsyncMock()
        await send_line_results(message, data['rows'])
        self.assertEqual(len(data['rows']), 12)
        text = message.reply_text.call_args.args[0]
        for index in range(12):
            self.assertIn(f'Línea: {index}\n', text)
        message.reply_document.assert_not_called()

    async def test_large_result_is_delivered_in_full_as_document(self):
        rows = [{'numObjetivo': str(index), 'nuc': 'x' * 100} for index in range(100)]
        message = AsyncMock()
        await send_line_results(message, rows)
        message.reply_text.assert_not_called()
        content = message.reply_document.call_args.kwargs['document'].getvalue().decode('utf-8')
        for index in range(100):
            self.assertIn(f'Línea: {index}\n', content)

    async def test_empty_result_is_explicit(self):
        message = AsyncMock()
        await send_line_results(message, [])
        message.reply_text.assert_awaited_once_with('No hay coincidencias para esa línea.')
