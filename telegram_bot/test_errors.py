import unittest
import httpx
from .errors import api_error_details


class ErrorTests(unittest.TestCase):
    def test_http_codes_identify_configuration_problems_without_exposing_request(self):
        for status, clue in [(401, 'TELEGRAM_API_TOKEN'), (403, 'TELEGRAM_ALLOWED_USER_IDS'), (404, 'ruta'), (503, 'MySQL')]:
            request = httpx.Request('GET', 'https://localhost/api/bot/linea?q=private-number', headers={'Authorization': 'Bearer secret'})
            response = httpx.Response(status, request=request)
            error = httpx.HTTPStatusError('sensitive error text', request=request, response=response)
            code, message = api_error_details(error)
            self.assertEqual(code, f'HTTP_{status}')
            self.assertIn(clue, message)
            self.assertNotIn('secret', message)
            self.assertNotIn('private-number', message)

    def test_timeouts_and_connection_errors_are_distinct(self):
        self.assertEqual(api_error_details(httpx.ReadTimeout('secret'))[0], 'API_TIMEOUT')
        self.assertEqual(api_error_details(httpx.ConnectError('secret'))[0], 'API_CONNECTION')
