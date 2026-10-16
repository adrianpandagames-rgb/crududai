import unittest
from .core import allowed_user_ids, can_query, format_row, query_for


class QueryTests(unittest.TestCase):
    def test_line_role_describes_the_requested_number_per_record(self):
        for objective, contact, expected in [(1, 0, 'Objetivo'), (0, 1, 'Contacto'), (1, 1, 'Objetivo y contacto')]:
            text = format_row('linea', {'numeroConsultado': '6621234567', 'numObjetivo': '6627654321', 'esObjetivo': objective, 'esContacto': contact})
            self.assertIn('Número consultado: 6621234567\n', text)
            self.assertIn(f'Rol: {expected}\n', text)
            self.assertIn('Línea objetivo: 6627654321\n', text)

    def test_only_authorized_private_chats_can_query(self):
        self.assertTrue(can_query('private', 123, {123}))
        self.assertFalse(can_query('private', 456, {123}))
        self.assertFalse(can_query('group', 123, {123}))
        self.assertFalse(can_query('supergroup', 123, {123}))

    def test_allowlist_is_required(self):
        for value in ('', '0', '-1', 'admin'):
            with self.assertRaises(ValueError):
                allowed_user_ids(value)
        self.assertEqual(allowed_user_ids('123, 456'), {123, 456})

    def test_line_matches_objective_and_contact(self):
        term, page = query_for('linea', ['6621234567', '--pagina', '2'])
        self.assertEqual(term, '6621234567')
        self.assertEqual(page, 2)

    def test_imei_is_exact_and_parameterized(self):
        self.assertEqual(query_for('imei', ['123456789012345']), ('123456789012345', 1))

    def test_location_text_is_not_interpolated(self):
        term = "' OR 1=1 --"
        self.assertEqual(query_for('antena', [term]), (term, 1))

    def test_coordinate_search(self):
        self.assertEqual(query_for('antena', ['29.072,', '-110.956']), ('29.072, -110.956', 1))

    def test_decimal_space_separator_and_range_validation(self):
        self.assertEqual(query_for('antena', ['29.072', '-110.956', '--pagina', '2']), ('29.072 -110.956', 2))
        self.assertEqual(query_for('antena', ['29', '-110']), ('29 -110', 1))
        with self.assertRaises(ValueError):
            query_for('antena', ['123', '456'])

    def test_dms_is_forwarded_without_losing_symbols_or_pagination(self):
        term = '29° 4\u0027 19.2\u0022 N, 110° 57\u0027 21.6\u0022 W'
        self.assertEqual(query_for('antena', [*term.split(), '--pagina', '2']), (term, 2))

    def test_invalid_queries(self):
        for command, args in [('linea', []), ('linea', ["' OR 1=1"]), ('imei', ['abc']), ('antena', ['91,0']), ('antena', ['lugar', '--pagina', '0']), ('antena', ['lugar', '--pagina', '101'])]:
            with self.assertRaises(ValueError):
                query_for(command, args)

    def test_location_response_has_valid_map_only(self):
        self.assertIn('https://www.google.com/maps?q=29.0,-110.0', format_row('antena', {'latitude': 29, 'longitude': -110}))
        self.assertNotIn('https://', format_row('antena', {'latitude': 'NaN', 'longitude': -110}))


if __name__ == '__main__':
    unittest.main()
