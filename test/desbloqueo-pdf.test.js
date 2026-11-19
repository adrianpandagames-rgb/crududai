import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findQpdf, isPdf, unlockPdf, unlockedName } from '../src/pdfUnlockService.js';

const qpdf = findQpdf();
const hasQpdf = spawnSync(qpdf, ['--version']).status === 0;

// An empty one-page PDF encrypted with the given passwords (made-up test file).
function encryptedPdf(userPassword, ownerPassword) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-test-'));
  try {
    const out = path.join(dir, 'p.pdf');
    const result = spawnSync(qpdf, ['--empty', '--encrypt', userPassword, ownerPassword, '256', '--print=none', '--modify=none', '--', out]);
    assert.equal(result.status, 0, String(result.stderr));
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const encrypted = (buffer) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-test-'));
  try {
    const file = path.join(dir, 'p.pdf');
    writeFileSync(file, buffer);
    return spawnSync(qpdf, ['--is-encrypted', file]).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('only files with a PDF header count as PDF', () => {
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n...')), true);
  assert.equal(isPdf(Buffer.from('no es pdf')), false);
  assert.equal(isPdf(null), false);
});

test('the download keeps the original name with -desbloqueado', () => {
  assert.equal(unlockedName('Oficio 12.PDF'), 'Oficio 12-desbloqueado.pdf');
  assert.equal(unlockedName('../../x.pdf'), 'x-desbloqueado.pdf');
  assert.equal(unlockedName(''), 'documento-desbloqueado.pdf');
});

test('QPDF_BIN wins over the search', () => {
  assert.equal(findQpdf({ QPDF_BIN: '/opt/qpdf' }, 'linux'), '/opt/qpdf');
  assert.equal(findQpdf({}, 'linux'), 'qpdf');
});

test('a PDF with only a permissions password comes out unlocked', { skip: !hasQpdf && 'qpdf no instalado' }, async () => {
  const input = encryptedPdf('', 'dueño-inventado');
  assert.equal(encrypted(input), true);
  const { buffer, wasEncrypted } = await unlockPdf(input);
  assert.equal(wasEncrypted, true);
  assert.equal(isPdf(buffer), true);
  assert.equal(encrypted(buffer), false);
});

test('a PDF that asks for a password to open needs it', { skip: !hasQpdf && 'qpdf no instalado' }, async () => {
  const input = encryptedPdf('abrir123', 'dueño-inventado');
  await assert.rejects(unlockPdf(input), /pide contraseña para abrirse/);
  await assert.rejects(unlockPdf(input, { password: 'mala' }), /no es correcta/);
  const { buffer } = await unlockPdf(input, { password: 'abrir123' });
  assert.equal(encrypted(buffer), false);
});

test('a non-PDF is rejected before calling qpdf', async () => {
  await assert.rejects(unlockPdf(Buffer.from('hola'), { bin: 'no-existe' }), /no es un PDF/);
});
