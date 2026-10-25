import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ejs from 'ejs';

const filesIn = async (dir, extension) => (await readdir(dir, { recursive: true }))
  .filter((name) => name.endsWith(extension)).map((name) => path.join(dir, name));

// Confirmations use the in-page toast (public/js/confirm-toast.js), never the browser's confirm() dialog.
test('no page asks through the browser confirm() dialog', async () => {
  const files = [...await filesIn('views', '.ejs'), ...await filesIn('public/js', '.js')]
    .filter((file) => !file.endsWith('confirm-toast.js'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /(^|[^.\w])confirm\(|window\.confirm\(|onsubmit=/, file);
  }
});

test('every page loads the confirmation toast', async () => {
  const head = await ejs.renderFile('views/includes/head.ejs', {});
  assert.match(head, /<script src="\/public\/js\/confirm-toast\.js" defer><\/script>/);
  assert.match(head, /href="\/public\/css\/confirm-toast\.css"/);
});
