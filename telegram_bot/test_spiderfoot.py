import json
import unittest

import httpx

from .api import rejected_reason, spiderfoot_csv, spiderfoot_status, start_spiderfoot
from .spiderfoot import MAX_WAIT_SECONDS, POLL_SECONDS, follow_spiderfoot, spiderfoot_arguments, spiderfoot_messages


def finished(**overrides):
    data = {'id': 'abc', 'target': 'ejemplo.com', 'type_label': 'Dominio', 'status': 'listo', 'total': 4, 'error': None,
            'notes': ['La búsqueda llegó a su tiempo máximo; se guardó lo encontrado hasta ese momento.'],
            'web_url': 'https://app.example/spiderfoot/abc',
            'categories': [
                {'label': 'Personas, cuentas y contacto', 'total': 3, 'types': [
                    {'label': 'Correo electrónico', 'count': 3, 'examples': ['a@ejemplo.com', 'b@ejemplo.com']}]},
                {'label': 'Datos sin procesar', 'total': 1, 'types': [{'label': 'WHOIS del dominio', 'count': 1, 'examples': []}]},
            ]}
    data.update(overrides)
    return data


class SpiderfootArgumentTests(unittest.TestCase):
    def test_target_type_and_depth(self):
        self.assertEqual(spiderfoot_arguments(['ejemplo.com']), (None, 'ejemplo.com', 'rapida'))
        self.assertEqual(spiderfoot_arguments(['+52', '6621234567', '--normal']), (None, '+52 6621234567', 'normal'))
        self.assertEqual(spiderfoot_arguments(['Usuario', 'juan.perez']), ('usuario', 'juan.perez', 'rapida'))
        self.assertEqual(spiderfoot_arguments(['teléfono', '+52', '6621234567']), ('telefono', '+52 6621234567', 'rapida'))
        self.assertEqual(spiderfoot_arguments(['Juan', 'Pérez']), (None, 'Juan Pérez', 'rapida'))
        # A lone type word is the target itself.
        self.assertEqual(spiderfoot_arguments(['usuario']), (None, 'usuario', 'rapida'))
        for args in [[], ['--normal'], ['x' * 256]]:
            with self.assertRaises(ValueError):
                spiderfoot_arguments(args)


class SpiderfootMessageTests(unittest.TestCase):
    def test_summary_lists_categories_examples_and_the_web_detail(self):
        [text] = spiderfoot_messages(finished())
        self.assertIn('SpiderFoot ejemplo.com (Dominio): 4 resultado(s).', text)
        self.assertIn('tiempo máximo', text)
        self.assertIn('Personas, cuentas y contacto (3)', text)
        self.assertIn('• Correo electrónico: 3', text)
        self.assertIn('   – a@ejemplo.com', text)
        self.assertIn('… y 1 más', text)
        self.assertIn('• WHOIS del dominio: 1', text)
        # Raw data comes without examples, so it gets no "y N más" line.
        self.assertEqual(text.count('… y'), 1)
        self.assertIn('Detalle: https://app.example/spiderfoot/abc', text)

    def test_long_summaries_are_split_under_the_telegram_limit(self):
        types = [{'label': f'Tipo {n}', 'count': 10, 'examples': ['x' * 200] * 10} for n in range(20)]
        messages = spiderfoot_messages(finished(categories=[{'label': 'Otros', 'total': 200, 'types': types}]))
        self.assertGreater(len(messages), 1)
        self.assertTrue(all(len(message) <= 4096 for message in messages))

    def test_failed_search_reports_the_error(self):
        self.assertEqual(spiderfoot_messages(finished(status='error', error='SpiderFoot no está instalado en el servidor.')),
                         ['La búsqueda de ejemplo.com no pudo completarse: SpiderFoot no está instalado en el servidor.'])


class FollowSpiderfootTests(unittest.IsolatedAsyncioTestCase):
    async def test_polls_until_done_then_sends_summary_and_csv(self):
        statuses = [httpx.ConnectError('caída'), {'status': 'pendiente', 'categories': []}, finished()]
        sent, files = [], []

        async def get_status(search_id):
            status = statuses.pop(0)
            if isinstance(status, Exception):
                raise status
            return status

        async def send_text(text):
            sent.append(text)

        async def send_csv(search_id, name):
            files.append((search_id, name))

        async def sleep(seconds):
            pass

        self.assertEqual(await follow_spiderfoot('abc', 'rapida', get_status, send_text, send_csv, sleep), 'listo')
        self.assertIn('ejemplo.com', sent[0])
        self.assertEqual(files, [('abc', 'ejemplo.com')])

    async def test_no_csv_without_results_and_gives_up_after_the_maximum_wait(self):
        sent = []

        async def send_text(text):
            sent.append(text)

        async def send_csv(search_id, name):
            raise AssertionError('No debe enviar CSV')

        async def sleep(seconds):
            pass

        async def empty(search_id):
            return finished(total=0, categories=[], notes=[])

        self.assertEqual(await follow_spiderfoot('abc', 'rapida', empty, send_text, send_csv, sleep), 'listo')

        async def pending(search_id):
            return {'status': 'procesando', 'categories': []}

        self.assertEqual(await follow_spiderfoot('abc', 'normal', pending, send_text, send_csv, sleep), 'timeout')
        self.assertIn('pestaña SpiderFoot', sent[-1])
        self.assertEqual(MAX_WAIT_SECONDS['normal'] % POLL_SECONDS, 0)


class SpiderfootApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_requests_send_identity_and_validate_answers(self):
        def respond(request):
            self.assertEqual(request.headers['X-Telegram-User-Id'], '123')
            if request.method == 'POST':
                self.assertEqual(request.url.path, '/api/bot/spiderfoot')
                self.assertEqual(json.loads(request.content), {'objetivo': 'juan.perez', 'modo': 'normal', 'tipo': 'usuario'})
                return httpx.Response(202, json={'id': 'abc', 'target': '@juan.perez', 'type_label': 'Usuario', 'mode': 'normal'})
            if request.url.path.endswith('/csv'):
                return httpx.Response(200, content=b'Categoria,Tipo\r\n')
            return httpx.Response(200, json=finished())
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(respond)) as client:
            self.assertEqual((await start_spiderfoot(client, 'usuario', 'juan.perez', 'normal', 123))['id'], 'abc')
            self.assertEqual((await spiderfoot_status(client, 'abc', 123))['status'], 'listo')
            self.assertEqual(await spiderfoot_csv(client, 'abc', 123), b'Categoria,Tipo\r\n')

    async def test_the_server_reason_for_a_rejected_target_is_shown(self):
        def respond(request):
            return httpx.Response(400, json={'error': 'Ingresa un dominio válido.'})
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(respond)) as client:
            with self.assertRaises(httpx.HTTPStatusError) as caught:
                await start_spiderfoot(client, None, 'x', 'rapida', 123)
        self.assertEqual(rejected_reason(caught.exception), 'Ingresa un dominio válido.')
        self.assertIsNone(rejected_reason(ValueError('x')))
