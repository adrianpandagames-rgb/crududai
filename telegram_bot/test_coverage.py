import unittest
from unittest.mock import AsyncMock
from .coverage import coverage_parameters, coverage_image, send_coverage, coverage_geocoding


class CoverageTests(unittest.TestCase):
    def test_default_and_optional_range(self):
        parameters = coverage_parameters(['29.0729', '-110.9559', '50°'])
        self.assertEqual(float(parameters['radius']), 500)
        self.assertEqual(float(parameters['azimuth']), 50)
        self.assertEqual(float(coverage_parameters(['29', '-110', '50', '1000'])['radius']), 1000)

    def test_invalid_inputs(self):
        for args in [[], ['nan', '-110', '50'], ['29', '-110', '360'], ['29', '-110', '50', '0']]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                coverage_parameters(args)

    def test_dms_conversion_and_optional_arguments(self):
        parameters = coverage_parameters('29° 4\' 19.2" N, 110° 57\' 21.6" W 50'.split())
        self.assertAlmostEqual(float(parameters['lat']), 29.072, places=8)
        self.assertAlmostEqual(float(parameters['lng']), -110.956, places=8)
        self.assertEqual(float(parameters['azimuth']), 50)
        self.assertNotIn('azimuth', coverage_parameters(['29', '-110']))
        parameters = coverage_parameters(['29', '-110', '--alcance', '1000'])
        self.assertNotIn('azimuth', parameters)
        self.assertEqual(float(parameters['radius']), 1000)
        for text in ['29°60\'0"N 110°0\'0"W', '29°0\'0"E 110°0\'0"W']:
            with self.assertRaises(ValueError):
                coverage_parameters(text.split())


class CoverageAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_geocoding_sends_explicit_post_with_coordinates_and_identity(self):
        import httpx
        import json
        def handler(request):
            self.assertEqual(request.method, 'POST')
            self.assertEqual(request.url.path, '/api/bot/cobertura/ubicacion')
            self.assertEqual(request.headers['X-Telegram-User-Id'], '123')
            self.assertEqual(json.loads(request.content), {'lat': '29.0000000000', 'lng': '-110.0000000000'})
            return httpx.Response(200, json={'rows': [{'ubicacion': 'Calle Uno', 'fuente': 'geocoding'}], 'status': 'OK'})
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(handler)) as client:
            data = await coverage_geocoding(client, coverage_parameters(['29', '-110']), 123)
            self.assertEqual(data['rows'][0]['ubicacion'], 'Calle Uno')
    async def test_interrupted_image_read_retries_once(self):
        import httpx
        calls = 0
        def handler(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise httpx.ReadError('Disconnected', request=request)
            return httpx.Response(200, headers={'content-type': 'image/png'}, content=b'\x89PNG\r\n\x1a\nTEST')
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(handler)) as client:
            image = await coverage_image(client, coverage_parameters(['29', '-110', '50']), 123)
            self.assertTrue(image.startswith(b'\x89PNG'))
            self.assertEqual(calls, 2)

    async def test_persistent_read_error_stops_after_two_attempts(self):
        import httpx
        calls = 0
        def handler(request):
            nonlocal calls
            calls += 1
            raise httpx.ReadError('Disconnected', request=request)
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(httpx.ReadError):
                await coverage_image(client, coverage_parameters(['29', '-110', '50']), 123)
            self.assertEqual(calls, 2)

    async def test_request_uses_authenticated_api_and_returns_png(self):
        import httpx
        def handler(request):
            self.assertEqual(request.url.path, '/api/bot/cobertura')
            self.assertEqual(request.headers['X-Telegram-User-Id'], '123')
            self.assertEqual(request.url.params['azimuth'], '50.0000000000')
            return httpx.Response(200, headers={'content-type': 'image/png'}, content=b'\x89PNG\r\n\x1a\nTEST')
        async with httpx.AsyncClient(base_url='https://localhost/', transport=httpx.MockTransport(handler)) as client:
            parameters = coverage_parameters(['29', '-110', '50'])
            image = await coverage_image(client, parameters, 123)
            message = AsyncMock()
            await send_coverage(message, image, parameters)
            kwargs = message.reply_photo.call_args.kwargs
            self.assertTrue(kwargs['protect_content'])
            self.assertEqual(kwargs['photo'].getvalue(), image)
            self.assertIn('500 m', kwargs['caption'])
