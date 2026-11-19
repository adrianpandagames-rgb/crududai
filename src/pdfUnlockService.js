// Removes the owner (permissions) password from a PDF with qpdf, on this server: the file never goes
// to an outside service. A PDF that asks for a password to open needs that password; without it qpdf
// cannot read the content.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 60_000;

export const isPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.subarray(0, 1024).includes('%PDF-');

// winget installs qpdf under Program Files without adding it to PATH; on Linux it is just "qpdf".
export function findQpdf(env = process.env, platform = process.platform) {
  if (env.QPDF_BIN) return env.QPDF_BIN;
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      try {
        const folder = readdirSync(base).filter((name) => /^qpdf/i.test(name)).sort().reverse()
          .map((name) => path.join(base, name, 'bin', 'qpdf.exe')).find((file) => existsSync(file));
        if (folder) return folder;
      } catch { /* folder not readable */ }
    }
  }
  return 'qpdf';
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new Error('qpdf no está instalado en el servidor.') : error);
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

// Returns { buffer, wasEncrypted }. Throws an Error whose message can be shown to the person.
export async function unlockPdf(input, { password = '', bin = findQpdf() } = {}) {
  if (!isPdf(input)) throw new Error('El archivo no es un PDF.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdf-'));
  try {
    await writeFile(path.join(dir, 'entrada.pdf'), input);
    // --is-encrypted: 0 = encrypted, 2 = not encrypted.
    const check = await run(bin, ['--is-encrypted', 'entrada.pdf'], dir);
    const wasEncrypted = check.code === 0;
    // The password goes in a file so it does not show in the server's process list.
    await writeFile(path.join(dir, 'clave.txt'), String(password));
    const result = await run(bin, ['--password-file=clave.txt', '--decrypt', 'entrada.pdf', 'salida.pdf'], dir);
    // 0 = ok, 3 = ok with warnings (common with damaged PDFs).
    if (result.code !== 0 && result.code !== 3) {
      if (/invalid password/i.test(result.output)) {
        throw new Error(password
          ? 'La contraseña de apertura no es correcta.'
          : 'Este PDF pide contraseña para abrirse. Escríbela en el campo «Contraseña de apertura».');
      }
      throw new Error('qpdf no pudo procesar el PDF; puede estar dañado.');
    }
    return { buffer: await readFile(path.join(dir, 'salida.pdf')), wasEncrypted };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function unlockedName(originalName) {
  const base = path.basename(String(originalName || 'documento.pdf')).replace(/\.pdf$/i, '') || 'documento';
  return `${base}-desbloqueado.pdf`;
}
