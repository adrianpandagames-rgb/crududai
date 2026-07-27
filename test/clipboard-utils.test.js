import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClipboardText } from '../src/clipboardUtils.js';

test('buildClipboardText formats values as tab-separated Excel rows', () => {
  const result = buildClipboardText(['Puerta principal', 'Oficina 2']);
  assert.equal(result, 'Puerta principal\tOficina 2\r\n');
});

test('buildClipboardText normalizes embedded line breaks before copying', () => {
  const result = buildClipboardText(['Primera\nlinea', 'Segunda\tcolumna']);
  assert.equal(result, 'Primera linea\tSegunda columna\r\n');
});
