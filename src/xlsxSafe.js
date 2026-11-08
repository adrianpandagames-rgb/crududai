// Reading uploaded Excel files with bounds. An .xlsx is a ZIP: a file of a few kilobytes can declare a sheet of
// A1:XFD1048576 or inflate to gigabytes, and SheetJS would walk all of it synchronously on the only event loop,
// stalling every user. Every upload goes through readWorkbook and boundSheet instead of XLSX.read directly.
import * as XLSX from 'xlsx';

export const XLSX_LIMITS = {
  // One more than the largest file the app accepts (100000 data rows plus the header), so callers still see
  // that a file is too long and refuse it instead of silently cutting it.
  rows: 100002,
  // Real case files have a few dozen columns; this keeps the worst case (every row filled out to the last
  // column) to a few seconds instead of hours.
  columns: 128,
  // Total size of the files inside the ZIP once decompressed.
  inflatedBytes: 200 * 1024 * 1024,
};

export class XlsxTooLargeError extends Error {}

// Sums the uncompressed sizes the ZIP central directory declares. ZIP64 archives (sizes over 4 GB) are refused:
// no real workbook needs them.
export function declaredInflatedSize(buffer) {
  const minEnd = Math.max(0, buffer.length - 65557);
  let end = -1;
  for (let i = buffer.length - 22; i >= minEnd; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || offset === 0xffffffff) return Infinity;
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) return Infinity;
    total += size;
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return total;
}

export function readWorkbook(buffer, options = {}) {
  const inflated = declaredInflatedSize(buffer);
  if (inflated !== null && inflated > XLSX_LIMITS.inflatedBytes) {
    throw new XlsxTooLargeError('El archivo Excel es demasiado grande una vez descomprimido.');
  }
  // nodim: the range comes from the cells actually present, not from the size the file claims for itself.
  return XLSX.read(buffer, { ...options, nodim: true, sheetRows: XLSX_LIMITS.rows });
}

// Narrows a sheet's range to the row and column limits before it is turned into rows.
export function boundSheet(worksheet) {
  if (!worksheet?.['!ref']) return worksheet;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  range.e.r = Math.min(range.e.r, range.s.r + XLSX_LIMITS.rows - 1);
  range.e.c = Math.min(range.e.c, range.s.c + XLSX_LIMITS.columns - 1);
  worksheet['!ref'] = XLSX.utils.encode_range(range);
  return worksheet;
}
