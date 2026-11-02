// The 15th digit of an IMEI is the Luhn check digit of the first 14.
export const calculateLuhnCheckDigit = (base) => {
  let sum = 0;

  for (let i = 0; i < base.length; i++) {
    let digit = Number(base[i]);
    if (i % 2 === 1) {
      digit *= 2;
    }
    sum += Math.floor(digit / 10) + (digit % 10);
  }

  return String((10 - (sum % 10)) % 10);
};

// Carriers write the same phone as 14 digits, as 15 with a 0 or a wrong last digit, or as a 16-digit IMEISV;
// all of them become the first 14 digits plus their check digit, so one phone is one record.
// Returns '' for anything shorter than 14 digits or a placeholder such as 00000000000000.
export function imeiCompleto(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 14 || digits.length > 16) return '';
  const base = digits.slice(0, 14);
  if (/^(\d)\1+$/.test(base)) return '';
  return base + calculateLuhnCheckDigit(base);
}

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
// "IMEI", "IMEI A", "IMEI origen"; the other party's device (IMEI B, IMEI destino) is not the target's phone.
const IMEI_HEADER = /^imei(?:[\W_]*(?:a|origen))?$/;
// A sábana lists one or a few phones; more than this means the column is not what it seems.
export const MAX_IMEIS_POR_ARCHIVO = 20;

// The distinct IMEIs of the target's phones in a carrier's file, completed with their check digit, in the order
// they first appear. The table header is the first row with an IMEI column; Telcel puts the holder's data above it.
// `demasiados` means the file has more than MAX_IMEIS_POR_ARCHIVO, and then none is taken.
export function imeisDeArchivo(sheets) {
  const imeis = [];
  for (const rows of sheets) {
    const headerIndex = rows.findIndex((row) => (row || []).some((cell) => IMEI_HEADER.test(fold(cell))));
    if (headerIndex === -1) continue;
    const column = rows[headerIndex].findIndex((cell) => IMEI_HEADER.test(fold(cell)));
    for (const row of rows.slice(headerIndex + 1)) {
      const imei = imeiCompleto(row?.[column]);
      if (imei && !imeis.includes(imei)) imeis.push(imei);
      if (imeis.length > MAX_IMEIS_POR_ARCHIVO) return { imeis: [], demasiados: true };
    }
  }
  return { imeis, demasiados: false };
}
