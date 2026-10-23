import json
import unittest

import httpx

from .api import maigret_report, maigret_status, start_maigret
from .maigret import MAX_WAIT_SECONDS, POLL_SECONDS, follow_search, maigret_arguments, maigret_messages


def finished(**overrides):
    data = {'id': 'abc', 'username': 'guero_hmo', 'status': 'listo', 'total': 2, 'error': None, 'has_report': True,
            'web_url': 'https://app.example/maigret/abc',
            'accounts': [{'username': 'guero_hmo', 'site': 'GitHub', 'url': 'https://github.com/guero_hmo', 'similar': False},
                         {'username': 'luisr_662', 'site': 'TikTok', 'url': 'https://tiktok.com/@luisr_662', 'similar': True}]}
    data.update(overrides)
    return data


class MaigretArgumentTests(unittest.TestCase):
    def test_username_and_depth(self):
        self.assertEqual(maigret_arguments(['@guero_hmo']), ('guero_hmo', 'rapida'))
        self.assertEqual(maigret_arguments(['--normal', 'luis.r-662']), ('luis.r-662', 'normal'))
        for args in [[], ['dos', 'palabras'], ['-a'], ['--all-sites'], ['ñandú'], ['a' * 65]]:
            with self.assertRaises(ValueError):
                maigret_arguments(args)


class MaigretMessageTests(unittest.TestCase):
    def test_results_group_aliases_and_link_the_web_detail(self):
        [text] = maigret_messages(finished())
        self.assertIn('Maigret @guero_hmo: 2 cuenta(s)', text)
        self.assertIn('• GitHub: https://github.com/guero_hmo', text)
        self.assertIn('Alias encontrado: @luisr_662', text)
        self.assertIn('• TikTok: https://tiktok.com/@luisr_662 (aproximada)', text)
        self.assertIn('Detalle: https://app.example/maigret/abc', text)

    def test_long_results_are_split_under_the_telegram_limit(self):
        accounts = [{'username': 'guero_hmo', 'site': f'Sitio {n}', 'url': 'https://example.com/' + 'x' * 80, 'similar': False}
                    for n in range(100)]
        messages = maigret_messages(finished(total=150, accounts=accounts))
        self.assertGreater(len(messages), 1)
        self.assertTrue(all(len(message) <= 4096 for message in messages))
        self.assertIn('Se muestran 100 de 150', messages[-1])

    def test_failed_search_reports_the_error(self):
        self.assertEqual(maigret_messages(finished(status='error', error='Maigret no está instalado en el servidor.')),
                         ['La búsqueda de @guero_hmo no pudo completarse: Maigret no está instalado en el servidor.'])


class FollowSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_polls_until_done_then_sends_results_and_report(self):
        statuses = [httpx.ConnectError('caída'), {'status': 'pendiente', 'accounts': []}, {'status': 'procesando', 'accounts': []}, finished()]
        sent, reports, sleeps = [], [], []

        async def get_status(search_id):
            status = statuses.pop(0)
            if isinstance(status, Exception):
                raise status
            return status

        async def send_text(text):
            sent.append(text)

        async def send_report(search_id, name):
            reports.append((search_id, name))

        async def sleep(seconds):
            sleeps.append(seconds)

        self.assertEqual(await follow_search('abc', 'rapida', get_status, send_text, send_report, sleep), 'listo')
        self.assertEqual(len(sleeps), 4)
        self.assertIn('GitHub', sent[0])
        self.assertEqual(reports, [('abc', 'guero_hmo')])

    async def test_gives_up_after_the_maximum_wait(self):
        sent = []

        async def get_status(search_id):
            return {'status': 'pendiente', 'accounts': []}

        async def send_text(text):
            sent.append(text)

        async def send_report(search_id, name):
            raise AssertionError('No debe enviar reporte')

        async def sleep(seconds):
            pass

        self.assertEqual(await follow_search('abc', 'rapida', get_status, send_text, send_report, sleep), 'timeout')
        self.assertIn('pestaña Maigret', sent[0])
        self.assertEqual(MAX_WAIT_SECONDS['rapida'] % POLL_SECONDS, 0)


class MaigretApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_requests_send_identity_and_validate_answers(self):
        def respond(request):
            self.assertEqual(request.headers['X-Telegram-User-Id'], '123')
            if request.method == 'POST':
                self.assertEqual(request.url.path, '/api/bot/maigret')
                self.assertEqual(json.loads(request.content), {'usuario': 'guero_hmo', 'modo': 'normal'})
                return httpx.Response(202, json={'id': 'abc', 'username': 'guero_hmo', 'mode': 'normal'})
            if request.url.path.endswith('/reporte'):
                return httpx.Response(200, content=b'<p>reporte</p>')
            return httpx.Response(200, json=finished())
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(respond)) as client:
            self.assertEqual((await start_maigret(client, 'guero_hmo', 'normal', 123))['id'], 'abc')
            self.assertEqual((await maigret_status(client, 'abc', 123))['status'], 'listo')
            self.assertEqual(await maigret_report(client, 'abc', 123), b'<p>reporte</p>')

    async def test_queue_full_is_an_error(self):
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(lambda request: httpx.Response(429, json={'error': 'cola'}))) as client:
            with self.assertRaises(httpx.HTTPStatusError):
                await start_maigret(client, 'guero_hmo', 'rapida', 123)
