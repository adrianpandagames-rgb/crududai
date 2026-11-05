import unittest

from .prompts import BUTTONS, Prompts


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class CoveragePromptTests(unittest.TestCase):
    def test_three_steps_build_the_parameters(self):
        prompts = Prompts()
        self.assertEqual(prompts.start(1, 'cobertura'), 'coords')
        self.assertEqual(prompts.answer(1, '29.0729 -110.9559'), ('ask', 'azimuth'))
        self.assertEqual(prompts.answer(1, '50°'), ('ask', 'radius'))
        kind, parameters = prompts.answer(1, '1000 m')
        self.assertEqual(kind, 'coverage')
        self.assertAlmostEqual(float(parameters['lat']), 29.0729)
        self.assertEqual(float(parameters['azimuth']), 50)
        self.assertEqual(float(parameters['radius']), 1000)
        self.assertIsNone(prompts.get(1))

    def test_default_buttons_give_full_circle_and_500_m(self):
        prompts = Prompts()
        prompts.start(1, 'cobertura')
        prompts.answer(1, '29°4\'19.2"N, 110°57\'21.6"W')
        prompts.answer(1, BUTTONS['guia:azimut:360'][1])
        _, parameters = prompts.answer(1, BUTTONS['guia:alcance:500'][1])
        self.assertAlmostEqual(float(parameters['lng']), -110.956, places=6)
        self.assertEqual(float(parameters['azimuth']), 360)
        self.assertEqual(float(parameters['radius']), 500)

    def test_invalid_answer_keeps_the_same_question(self):
        prompts = Prompts()
        prompts.start(1, 'cobertura')
        for text in ['', 'hola', '29.0729', '95 -110', '29 -110 50']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                prompts.answer(1, text)
        self.assertEqual(prompts.get(1)['step'], 'coords')
        prompts.answer(1, '29 -110')
        for text in ['361', '-1', 'nan', 'norte']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                prompts.answer(1, text)
        prompts.answer(1, '0')
        for text in ['0', '10001', '1 km']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                prompts.answer(1, text)
        self.assertEqual(prompts.get(1)['step'], 'radius')


class SingleValuePromptTests(unittest.TestCase):
    def test_valid_value_runs_the_command_with_its_words(self):
        prompts = Prompts()
        prompts.start(1, 'maigret')
        self.assertEqual(prompts.answer(1, 'guero_hmo --normal'), ('run', 'maigret', ['guero_hmo', '--normal']))
        self.assertIsNone(prompts.get(1))

    def test_invalid_value_keeps_the_question(self):
        prompts = Prompts()
        prompts.start(1, 'linea')
        with self.assertRaises(ValueError):
            prompts.answer(1, '662-123')
        self.assertEqual(prompts.answer(1, '6621234567'), ('run', 'linea', ['6621234567']))

    def test_questions_are_per_user_expire_and_clear(self):
        clock = Clock()
        prompts = Prompts(ttl=60, clock=clock)
        prompts.start(1, 'imei')
        self.assertIsNone(prompts.answer(2, '123456789012345'))
        clock.now = 61
        self.assertIsNone(prompts.answer(1, '123456789012345'))
        prompts.start(1, 'imei')
        self.assertTrue(prompts.clear(1))
        self.assertFalse(prompts.clear(1))
