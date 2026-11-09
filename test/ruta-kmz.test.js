import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRutaCsv, processRutaCsv } from '../src/rutaService.js';
import { BALLOON_ROWS, createRutaKml, createRutaKmz, readRutaRecords } from '../src/rutaKmz.js';

// Reads back the single entry of the ZIP the way any unzip tool would: local header, then the deflated data.
const unzipSingle = (buffer) => {
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  const method = buffer.readUInt16LE(8);
  const crc = buffer.readUInt32LE(14);
  const compressedSize = buffer.readUInt32LE(18);
  const nameLength = buffer.readUInt16LE(26);
  const name = buffer.subarray(30, 30 + nameLength).toString('utf8');
  const data = zlib.inflateRawSync(buffer.subarray(30 + nameLength, 30 + nameLength + compressedSize));
  assert.equal(method, 8);
  assert.equal(zlib.crc32(data), crc, 'CRC matches');
  const end = buffer.subarray(buffer.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50, 'ends with the end-of-central-directory record');
  assert.equal(end.readUInt16LE(10), 1);
  assert.equal(buffer.readUInt32LE(end.readUInt32LE(16)), 0x02014b50, 'central directory where the end record says');
  return { name, text: data.toString('utf8') };
};

const resultCsv = () => '﻿' + createRutaCsv(processRutaCsv([
  'fecha,hora,numero b,latitud,longitud',
  '13/10/2026,10:00:05,6621112233,29.072967,-110.955919',
  '13/10/2026,10:20:00,6621112233,29.100000,-110.900000',
  '13/10/2026,09:00:00,6624445566,29.072967,-110.955919',
  '14/10/2026,08:15:00,<script>alert(1)</script>,29.072967,-110.955919',
  '14/10/2026,08:30:00,6620000000,,',
].join('\n'), []));

test('the KMZ is a valid ZIP holding doc.kml', () => {
  const { name, text } = unzipSingle(createRutaKmz(resultCsv(), { lineNumber: '6621234567' }));
  assert.equal(name, 'doc.kml');
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(text.includes('<name>Ruta 6621234567</name>'));
});

test('every record is in the file: by antenna, by day, and the ones without a position apart', () => {
  const kml = createRutaKml(resultCsv());
  const { records } = readRutaRecords(resultCsv());
  assert.equal(records.length, 5);

  // Two antennas; the first one has three records.
  assert.ok(kml.includes('<Folder><name>Antenas (2)</name>'));
  assert.ok(kml.includes('<b>Antena 1</b> — 3 registros'));
  assert.ok(kml.includes('<b>Antena 2</b> — 1 registro<br>'));
  assert.ok(kml.includes('Primer registro: 13/10/2026 09:00:00<br>Último registro: 14/10/2026 08:15:00'));
  assert.ok(kml.includes('<b>Registros por día</b><br>13/10/2026: 2<br>14/10/2026: 1'));

  // "Por día": a hidden folder per day, one entry per record named by time and antenna, in time order.
  assert.ok(kml.includes('<Folder><name>Por día</name><visibility>0</visibility>'));
  assert.ok(kml.includes('<Folder><name>13/10/2026 — 3 registros · 2 antenas</name><visibility>0</visibility>'));
  assert.ok(kml.includes('<Folder><name>14/10/2026 — 1 registro · 1 antena</name>'));
  const names = [...kml.matchAll(/<Placemark><name>([^<]+)<\/name><visibility>0<\/visibility><styleUrl>#registro/g)].map((match) => match[1]);
  assert.deepEqual(names, ['09:00:00 · Antena 1', '10:00:05 · Antena 1', '10:20:00 · Antena 2', '08:15:00 · Antena 1']);
  assert.ok(kml.includes('<TimeStamp><when>2026-10-13T09:00:00-07:00</when></TimeStamp>'));

  // The day's route goes 09:00 antenna 1 → 10:00 antenna 1 (same stop) → 10:20 antenna 2, inside that day's folder.
  const day13 = kml.slice(kml.indexOf('<Folder><name>13/10/2026'), kml.indexOf('<Folder><name>14/10/2026'));
  assert.ok(day13.includes('Recorrido del día (2 paradas)'));
  assert.ok(day13.includes('09:00:00 — antena 1<br>10:20:00 — antena 2'));
  assert.ok(day13.includes('<coordinates>-110.955919,29.072967,0 -110.9,29.1,0</coordinates>'));

  // The record without coordinates is not lost.
  assert.ok(kml.includes('<Folder><name>Sin ubicación (1)</name>'));
  assert.ok(kml.includes('6620000000'));
});

test('balloons stay light for Google Earth, and every record still has its own entry by day', () => {
  const total = BALLOON_ROWS * 3 + 7;
  const lines = ['fecha,hora,numero b,latitud,longitud'];
  for (let i = 0; i < total; i += 1) {
    const day = i < total / 2 ? '13' : '14';
    lines.push(`${day}/10/2026,10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},66${String(i).padStart(8, '0')},29.072967,-110.955919`);
  }
  for (let i = 0; i < BALLOON_ROWS + 5; i += 1) lines.push(`15/10/2026,11:00:00,77${String(i).padStart(8, '0')},,`);
  const kml = createRutaKml(createRutaCsv(processRutaCsv(lines.join('\n'), [])));

  const balloons = [...kml.matchAll(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/g)].map((match) => match[1]);
  assert.ok(balloons.every((html) => (html.match(/<tr><td>/g) || []).length <= BALLOON_ROWS), 'no balloon lists more than the cap');
  assert.ok(!kml.includes('<details'), 'folded rows still froze Google Earth; none are used');
  assert.ok(!kml.includes(';balloon'), 'links between features do nothing in Google Earth web');

  const antenna = balloons.find((html) => html.includes('<b>Antena 1</b>'));
  assert.ok(antenna.includes(`Se muestran los primeros ${BALLOON_ROWS} de ${total} registros`));
  assert.ok(antenna.includes('13/10/2026: 154<br>14/10/2026: 153'));

  // Every located record is its own entry, and every one without a position is listed.
  for (let i = 0; i < total; i += 1) assert.ok(kml.includes(`<td>66${String(i).padStart(8, '0')}</td></tr>`));
  assert.equal((kml.match(/<styleUrl>#registro<\/styleUrl>/g) || []).length, total);
  assert.ok(kml.includes(`<Folder><name>Sin ubicación (${BALLOON_ROWS + 5})</name>`));
  for (let i = 0; i < BALLOON_ROWS + 5; i += 1) assert.ok(kml.includes(`77${String(i).padStart(8, '0')}`));
});

test('cell text never becomes markup in the balloons', () => {
  const kml = createRutaKml(resultCsv());
  assert.ok(!kml.includes('<script>'));
  assert.ok(kml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // Only the CDATA sections themselves close with ]]>.
  assert.equal((kml.match(/\]\]>/g) || []).length, (kml.match(/<!\[CDATA\[/g) || []).length);
});
