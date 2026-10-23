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

export function createMaigretPdf({ search, groups, modeLabel }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true,
    info: { Title: pdfSafeText(`Reporte Maigret - ${search.username}`), Author: 'CRUDUDAI' } });
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
  text(`Reporte Maigret · @${search.username}`, { align: 'center' });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  text('Búsqueda de nombre de usuario en sitios públicos', { align: 'center' });
  doc.moveDown(1.2);

  const fact = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text(pdfSafeText(`${label}: `), left, doc.y, { continued: true });
    doc.font('Helvetica').fillColor(INK).text(pdfSafeText(value || '—'));
  };
  fact('Solicitó', search.requestedBy);
  fact('Inicio', search.createdAt);
  fact('Término', search.finishedAt);
  fact('Profundidad', `${modeLabel}${search.recursiveSearch ? ' · con alias' : ''}`);
  fact('Cuentas encontradas', String(search.accounts));
  if (search.error) fact('Aviso', search.error);
  doc.moveDown(0.6);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED);
  text('Maigret solo consulta perfiles públicos. Que exista una cuenta con el mismo nombre de usuario no confirma que sea la misma persona: cada perfil debe verificarse.');

  if (groups.length === 0) {
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(10.5).fillColor(INK);
    text('No se encontraron cuentas con ese nombre de usuario.');
  }

  groups.forEach((group, index) => {
    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK);
    text(`@${group.username}${index > 0 ? '  (alias encontrado en otro perfil)' : ''}`);
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor('#c9d3dc').stroke();
    doc.moveDown(0.5);
    group.accounts.forEach((account) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK);
      text(`${account.site}${account.similar ? '  (coincidencia aproximada)' : ''}`);
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
      .text(pdfSafeText(`Reporte Maigret · @${search.username} · página ${page + 1} de ${range.count}`), left, bottom, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
