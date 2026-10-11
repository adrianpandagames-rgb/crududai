import unittest
import httpx
from .api import search_api


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_commands_send_identity_and_query_to_node(self):
        for command, term in [('linea', '6621234567'), ('imei', '123456789012345'), ('antena', 'Hermosillo'), ('antena', '29°4\u002719.2\u0022N, 110°57\u002721.6\u0022W')]:
            def respond(request):
                self.assertEqual(request.url.path, '/api/bot/' + command)
                self.assertEqual(request.url.params['q'], term)
                self.assertEqual(request.url.params['page'], '2')
                self.assertEqual(request.headers['X-Telegram-User-Id'], '123')
                self.assertEqual(request.headers['Authorization'], 'Bearer test')
                return httpx.Response(200, json={'rows': [{'test': True}], 'has_more': False})
            async with httpx.AsyncClient(base_url='https://localhost/', headers={'Authorization': 'Bearer test'}, transport=httpx.MockTransport(respond)) as client:
                data = await search_api(client, command, term, 2, 123)
                self.assertEqual(data['rows'], [{'test': True}])

    async def test_api_errors_are_not_results(self):
        for status in (401, 403, 503):
            async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(lambda request: httpx.Response(status, json={'error': 'failure'}))) as client:
                with self.assertRaises(httpx.HTTPStatusError):
                    await search_api(client, 'linea', '6621234567', 1, 123)

    async def test_redirect_is_not_followed(self):
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(lambda request: httpx.Response(302, headers={'Location': '/login'}))) as client:
            with self.assertRaises(httpx.HTTPStatusError):
                await search_api(client, 'linea', '6621234567', 1, 123)
