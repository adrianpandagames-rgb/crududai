// Image intake for reverse search: detects the format, reads metadata and builds a metadata-free public copy.
import crypto from 'node:crypto';
import exifr from 'exifr';

export const IMAGE_TYPES = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg', searchable: true },
  png: { mime: 'image/png', extension: 'png', searchable: true },
  gif: { mime: 'image/gif', extension: 'gif', searchable: true },
  webp: { mime: 'image/webp', extension: 'webp', searchable: true },
  // Search engines cannot open HEIC (iPhone) photos, but their metadata is still read.
  heic: { mime: 'image/heic', extension: 'heic', searchable: false },
};

// The type comes from the file signature, never from the name or the browser's claim.
export function detectImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp'
    && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(buffer.subarray(8, 12).toString('latin1'))) return 'heic';
  return null;
}

// JPEG keeps JFIF (APP0), the color profile (APP2 ICC) and Adobe color data (APP14); EXIF, XMP, IPTC, comments
// and the MPF index (APP2 "MPF") go. The copy ends at the primary image's end marker: phones append further
// complete JPEGs after it (MPF secondary images, each with its own EXIF and GPS) and motion-photo or depth data,
// none of which belongs in the public copy. Progressive JPEGs have several scans, with tables between them, so
// the whole file is walked segment by segment, skipping each scan's compressed data.
const stripJpeg = (buffer) => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset + 2 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset += 1; continue; } // fill byte before a marker
    if (marker === 0xd9) {
      parts.push(buffer.subarray(offset, offset + 2));
      return Buffer.concat(parts);
    }
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) return null;
    if (marker === 0xda) {
      // Compressed data runs until the next marker; inside it 0xFF is followed by 0x00 (stuffing),
      // a restart marker (0xD0-0xD7) or another 0xFF (fill).
      let scan = end;
      while (scan + 1 < buffer.length) {
        if (buffer[scan] === 0xff) {
          const next = buffer[scan + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { scan += 2; continue; }
          if (next !== 0xff) break;
        }
        scan += 1;
      }
      if (scan + 1 >= buffer.length) return null;
      parts.push(buffer.subarray(offset, scan));
      offset = scan;
      continue;
    }
    const isMpf = marker === 0xe2 && buffer.subarray(offset + 4, offset + 8).toString('latin1') === 'MPF\0';
    const isMetadata = isMpf || marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2 && marker !== 0xee);
    if (!isMetadata) parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  return null;
};

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
const stripPng = (buffer) => {
  const parts = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(buffer.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return null;
};

// Returns the copy sent to search engines and whether its metadata could be removed.
export function createPublicCopy(buffer, type) {
  const stripped = type === 'jpeg' ? stripJpeg(buffer) : type === 'png' ? stripPng(buffer) : null;
  return stripped ? { buffer: stripped, stripped: true } : { buffer, stripped: false };
}

const SUMMARY_FIELDS = [
  ['DateTimeOriginal', 'Fecha y hora de la toma'],
  ['OffsetTimeOriginal', 'Zona horaria de la toma'],
  ['CreateDate', 'Fecha de creación'],
  ['ModifyDate', 'Fecha de modificación'],
  ['Make', 'Marca'],
  ['Model', 'Modelo'],
  ['BodySerialNumber', 'Número de serie del equipo'],
  ['LensModel', 'Lente'],
  ['Software', 'Software'],
  ['CreatorTool', 'Herramienta de edición'],
  ['Artist', 'Autor'],
  ['Copyright', 'Derechos'],
  ['ImageDescription', 'Descripción'],
  ['UserComment', 'Comentario'],
  ['Comment', 'Comentario'],
  ['GPSAltitude', 'Altitud (m)'],
  ['GPSImgDirection', 'Dirección de la cámara (°)'],
  ['GPSDateStamp', 'Fecha GPS'],
  ['ExifImageWidth', 'Ancho (px)'],
  ['ExifImageHeight', 'Alto (px)'],
  ['ImageWidth', 'Ancho (px)'],
  ['ImageHeight', 'Alto (px)'],
];
const MAX_FIELDS = 300;
const MAX_VALUE_LENGTH = 500;

// EXIF dates have no time zone; "2026:09:14 21:37:05" is shown exactly as the device recorded it.
const formatValue = (value) => {
  if (value instanceof Uint8Array) return `[datos binarios, ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return (/^\d{4}:\d{2}:\d{2}( |$)/.test(text) ? text.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : text).slice(0, MAX_VALUE_LENGTH);
};

export async function readImageMetadata(buffer) {
  let raw;
  try {
    raw = await exifr.parse(buffer, {
      tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, interop: false,
      makerNote: false, userComment: true, mergeOutput: true, translateValues: true, reviveValues: false,
    });
  } catch {
    raw = null;
  }
  const entries = Object.entries(raw ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const values = Object.fromEntries(entries);
  const seenLabels = new Set();
  const summary = [];
  for (const [key, label] of SUMMARY_FIELDS) {
    if (!(key in values) || seenLabels.has(label)) continue;
    seenLabels.add(label);
    summary.push({ label, value: formatValue(values[key]) });
  }
  const latitude = Number(values.latitude);
  const longitude = Number(values.longitude);
  const hasGps = Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return {
    summary,
    gps: hasGps ? { latitude: Number(latitude.toFixed(7)), longitude: Number(longitude.toFixed(7)) } : null,
    all: entries.slice(0, MAX_FIELDS).map(([key, value]) => ({ key, value: formatValue(value) })),
  };
}

export const hashImage = (buffer) => ({
  sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  md5: crypto.createHash('md5').update(buffer).digest('hex'),
});

export function reverseSearchLinks(publicUrl) {
  const url = encodeURIComponent(publicUrl);
  return [
    { name: 'Google Lens', href: `https://lens.google.com/uploadbyurl?url=${url}` },
    { name: 'Yandex', href: `https://yandex.com/images/search?rpt=imageview&url=${url}` },
    { name: 'Bing', href: `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${url}` },
    { name: 'TinEye', href: `https://tineye.com/search?url=${url}` },
  ];
}
