import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Any text before the doctype opens <body> early, so the theme styles load late and the page flashes white.
test('every full page starts with the doctype', async () => {
  const directory = new URL('../views/pages/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.ejs')) continue;
    const source = await readFile(new URL(name, directory), 'utf8');
    if (!/<html[\s>]/i.test(source)) continue;
    assert.match(source, /^<!DOCTYPE html>/i, `${name} tiene contenido antes de <!DOCTYPE html>`);
  }
});
