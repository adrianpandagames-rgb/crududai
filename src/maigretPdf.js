// Spanish PDF version of a Maigret search, built from the stored results rather than Maigret's own HTML.
import PDFDocument from 'pdfkit';

const INK = '#182b40';
const MUTED = '#5b6b7b';
const LINK = '#1a56b0';
const WIN_ANSI_EXTRAS = new Set([...'–—‘’‚“”„•…€™']);

// The built-in PDF fonts only cover Western characters; anything else is shown as "?".
export const pdfSafeText = (value) => [...String(value ?? '')]
  .map((char) => (char.charCodeAt(0) <= 0xff || WIN_ANSI_EXTRAS.has(char) ? char : '?'))
  .join('')
  .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ');

const KINDS = {
  usuario: { title: 'Reporte Maigret', subtitle: 'Búsqueda de nombre de usuario en sitios públicos (Maigret y Sherlock)', prefix: '@' },
  correo: { title: 'Reporte de correo', subtitle: 'Sitios donde el correo está registrado (Holehe)', prefix: '' },
  telefono: { title: 'Reporte de teléfono', subtitle: 'Sitios donde el teléfono está registrado (Ignorant)', prefix: '' },
};

const confidenceLabel = (sources = []) => (sources.includes('maigret') && sources.includes('sherlock') ? 'confirmado por Maigret y Sherlock'
  : sources.includes('sherlock') ? 'solo Sherlock' : 'solo Maigret');

export function createMaigretPdf({ search, groups, modeLabel, extras = {} }) {
  const kind = KINDS[search.type] || KINDS.usuario;
  const isUsername = kind === KINDS.usuario;
  const shown = `${kind.prefix}${search.username}`;
  const showConfidence = isUsername && Boolean(extras.crossChecked);
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true,
    info: { Title: pdfSafeText(`${kind.title} - ${search.username}`), Author: 'CRUDUDAI' } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // The x position is always explicit: pdfkit otherwise keeps the indentation of the previous field.
  const text = (value, options = {}) => doc.text(pdfSafeText(value), left, doc.y, { width, ...options });

  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK);
  text(`${kind.title} · ${shown}`, { align: 'center' });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  text(kind.subtitle, { align: 'center' });
  doc.moveDown(1.2);

  const fact = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text(pdfSafeText(`${label}: `), left, doc.y, { continued: true });
    doc.font('Helvetica').fillColor(INK).text(pdfSafeText(value || '—'));
  };
  fact('Solicitó', search.requestedBy);
  fact('Inicio', search.createdAt);
  fact('Término', search.finishedAt);
  if (isUsername) fact('Profundidad', `${modeLabel}${search.recursiveSearch ? ' · con alias' : ''}`);
  fact(isUsername ? 'Cuentas encontradas' : 'Sitios donde está registrado', String(search.accounts));
  if (showConfidence) {
    const confirmed = groups.flatMap((group) => group.accounts).filter((account) => confidenceLabel(account.sources).startsWith('confirmado')).length;
    fact('Confirmadas por ambos motores', String(confirmed));
  }
  if (search.error) fact('Aviso', search.error);
  for (const note of extras.notes ?? []) fact('Aviso', note);
  if (extras.unverified?.length) fact('No se pudieron verificar', extras.unverified.join(', '));
  doc.moveDown(0.6);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED);
  text(isUsername
    ? 'Maigret y Sherlock solo consultan perfiles públicos. Que exista una cuenta con el mismo nombre de usuario no confirma que sea la misma persona: cada perfil debe verificarse.'
    : 'Que un sitio indique que el dato está registrado no dice quién es el titular de la cuenta: cada resultado debe verificarse.');

  if (groups.length === 0) {
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(10.5).fillColor(INK);
    text(isUsername ? 'No se encontraron cuentas con ese nombre de usuario.' : 'No se encontró ningún sitio donde el dato esté registrado.');
  }

  groups.forEach((group, index) => {
    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK);
    text(`${kind.prefix}${group.username}${index > 0 ? '  (alias encontrado en otro perfil)' : ''}`);
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor('#c9d3dc').stroke();
    doc.moveDown(0.5);
    group.accounts.forEach((account) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK);
      text(`${account.site}${account.similar ? '  (coincidencia aproximada)' : ''}${showConfidence ? `  · ${confidenceLabel(account.sources)}` : ''}`);
      if (account.url) {
        doc.font('Helvetica').fontSize(9).fillColor(LINK);
        text(account.url, { link: account.url, underline: false });
      }
      if (account.tags?.length) {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED);
        text(`Categorías: ${account.tags.join(', ')}`);
      }
      for (const field of account.fields ?? []) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(pdfSafeText(`${field.key}: `), left + 10, doc.y, { width: width - 10, continued: true });
        doc.font('Helvetica').fillColor(INK).text(pdfSafeText(field.value));
      }
      doc.moveDown(0.6);
    });
  });

  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    // Writing below the bottom margin would otherwise make pdfkit open an extra page.
    doc.page.margins.bottom = 0;
    const bottom = doc.page.height - 35;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(pdfSafeText(`${kind.title} · ${shown} · página ${page + 1} de ${range.count}`), left, bottom, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
