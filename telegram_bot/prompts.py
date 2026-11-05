import time

from .core import query_for
from .coverage import coverage_azimuth, coverage_coordinates, coverage_parameters, coverage_radius
from .maigret import maigret_arguments
from .spiderfoot import spiderfoot_arguments

# An unanswered question expires so a later, unrelated message is not read as its answer.
PROMPT_TTL_SECONDS = 10 * 60
DEFAULT_RADIUS = '500'
FULL_CIRCLE = '360'

# Commands that need a single value: question, input placeholder (max. 64 characters) and validator.
SINGLE_VALUE = {
    'linea': ('Escribe la línea o el número de contacto a consultar, sin espacios ni guiones.',
              '6621234567', lambda args: query_for('linea', args)),
    'imei': ('Escribe el IMEI a consultar.', '123456789012345', lambda args: query_for('imei', args)),
    'antena': ('Escribe la dirección, el lugar o las coordenadas de la antena.',
               'Hermosillo o 29.072 -110.956', lambda args: query_for('antena', args)),
    'maigret': ('Escribe el nombre de usuario a buscar. Añade --normal para buscar en 500 sitios.',
                'guero_hmo', maigret_arguments),
    'spiderfoot': ('Escribe el objetivo: dominio, IP, correo, +52 teléfono, @usuario o nombre. '
                   'Añade --normal para la búsqueda de hasta 1 hora.', 'ejemplo.com', spiderfoot_arguments),
}

COVERAGE_STEPS = {
    'coords': ('Paso 1 de 3 · Coordenadas de la antena.\nEn decimal o DMS, por ejemplo: 29.0729 -110.9559',
               '29.0729 -110.9559'),
    'azimuth': ('Paso 2 de 3 · Azimut en grados (0 a 360).\nEscríbelo, o toca el botón si no lo tienes '
                'para ver la circunferencia completa de la antena.', '50'),
    'radius': ('Paso 3 de 3 · Alcance en metros (1 a 10000).\nEscríbelo, o toca el botón para usar 500 m.', '500'),
}
# Inline buttons of the coverage steps: callback data -> (step it answers, value, label shown after choosing).
BUTTONS = {
    'guia:azimut:360': ('azimuth', FULL_CIRCLE, 'Sin azimut: circunferencia'),
    'guia:alcance:500': ('radius', DEFAULT_RADIUS, '500 m'),
}
CANCEL = 'guia:cancelar'


class Prompts:
    def __init__(self, ttl=PROMPT_TTL_SECONDS, clock=time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._pending = {}

    def start(self, user_id, command):
        step = 'coords' if command == 'cobertura' else 'value'
        self._pending[user_id] = {'command': command, 'step': step, 'values': {}, 'at': self._clock()}
        return step

    def get(self, user_id):
        state = self._pending.get(user_id)
        if state and self._clock() - state['at'] > self._ttl:
            del self._pending[user_id]
            return None
        return state

    def clear(self, user_id):
        return self._pending.pop(user_id, None) is not None

    def answer(self, user_id, text):
        """Validate the answer to the current question.

        Returns ('ask', step) when another question follows, ('run', command, args) for a single-value
        command and ('coverage', parameters) when /cobertura is complete. Invalid answers raise ValueError
        and keep the question open so the user can retry.
        """
        state = self.get(user_id)
        if state is None:
            return None
        command, step = state['command'], state['step']
        if command != 'cobertura':
            args = (text or '').split()
            SINGLE_VALUE[command][2](args)
            self.clear(user_id)
            return ('run', command, args)
        values = state['values']
        if step == 'coords':
            values['coords'] = coverage_coordinates(text)
            next_step = 'azimuth'
        elif step == 'azimuth':
            values['azimuth'] = coverage_azimuth(text)
            next_step = 'radius'
        else:
            values['radius'] = coverage_radius(text)
            self.clear(user_id)
            return ('coverage', coverage_parameters([values['coords'], values['azimuth'], values['radius']]))
        state['step'] = next_step
        state['at'] = self._clock()
        return ('ask', next_step)
