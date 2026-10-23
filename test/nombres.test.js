import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  buildNameIndex, isIdentifierQuery, normalizeName, parseOfac, parseSat69b, phoneticKey,
  preparedSearches, searchNameIndex, usernameVariants, withinOneEdit,
} from '../src/nameSearchService.js';
import { createNombresRouter } from '../src/nombresRouter.js';
import zlib from 'node:zlib';
import { createDenueDirectory, csvRows, fulltextQuery, stateCodeFor, toBusiness, zipEntryStream } from '../src/denueService.js';
import { MaigretQueueFullError } from '../src/maigretRouter.js';

const SDN = [
  '12345,"GUZMAN LOERA, Joaquin","individual","SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 04 Apr 1957; POB Sinaloa, Mexico; C.U.R.P. GULJ570404HSLZRQ02."',
  '22222,"CARGO SHIP STAR","vessel","SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '33333,"COMERCIALIZADORA EJEMPLO, S.A. DE C.V.",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"R.F.C. CEJ0101019A1 (Mexico)."',
].join('\n');
const ALT = '12345,1,"aka","EL CHAPO",-0- \n99999,2,"aka","SIN PRINCIPAL",-0- ';
const SAT = [
  '"Información actualizada al 31 de diciembre de 2025"',
  'Listado completo de contribuyentes (Artículo 69-B del CFF),,,,',
  'No,RFC,Nombre del Contribuyente,Situación del contribuyente,Número y fecha de oficio',
  '1,AAA080808HL8,"ASESORES EN AVALÚOS Y ACTIVOS, S.A. DE C.V.",Definitivo,500-05-2018-16632',
  '2,RAGL800101AB1,"RAMÍREZ GÓMEZ LUIS",Presunto,500-05-2019-1',
].join('\r\n');

const index = buildNameIndex([...parseOfac(SDN, ALT), ...parseSat69b(SAT)]);

test('names compare without accents, punctuation or case, and Spanish sounds share a key', () => {
  assert.equal(normalizeName('  Ramírez-Gómez, LUIS  '), 'ramirez gomez luis');
  assert.equal(phoneticKey('joaquin'), phoneticKey('joakin'));
  assert.equal(phoneticKey('guzman'), phoneticKey('gusman'));
  assert.equal(phoneticKey('valdez'), phoneticKey('baldes'));
  assert.notEqual(phoneticKey('chavez'), phoneticKey('cabes'));
  assert.ok(withinOneEdit('loera', 'lopera'));
  assert.ok(withinOneEdit('ramirez', 'ramires'));
  assert.ok(!withinOneEdit('ramirez', 'ramos'));
});

test('OFAC keeps people, companies and their aliases; SAT starts after its header', () => {
  const ofac = parseOfac(SDN, ALT);
  assert.deepEqual(ofac.map((entry) => entry.name), ['GUZMAN LOERA, Joaquin', 'COMERCIALIZADORA EJEMPLO, S.A. DE C.V.', 'EL CHAPO']);
  assert.equal(ofac[0].details.tipo, 'Persona');
  assert.equal(ofac[2].details.aliasDe, 'GUZMAN LOERA, Joaquin');
  const sat = parseSat69b(SAT);
  assert.deepEqual(sat.map((entry) => [entry.sourceId, entry.details.tipo, entry.details.situacion]),
    [['AAA080808HL8', 'Persona moral', 'Definitivo'], ['RAGL800101AB1', 'Persona física', 'Presunto']]);
});

test('search matches any word order, accents, one-letter typos and similar sounds', () => {
  const names = (query) => searchNameIndex(index, query).map((result) => `${result.name}${result.exact ? '' : ' ~'}`);
  assert.deepEqual(names('Joaquín Guzmán Loera'), ['GUZMAN LOERA, Joaquin']);
  assert.deepEqual(names('Joakin Gusman'), ['GUZMAN LOERA, Joaquin ~']);
  assert.deepEqual(names('Luis Ramires'), ['RAMÍREZ GÓMEZ LUIS ~']);
  assert.deepEqual(names('el chapo'), ['EL CHAPO']);
  assert.equal(searchNameIndex(index, 'el chapo')[0].details.aliasDe, 'GUZMAN LOERA, Joaquin');
  assert.deepEqual(names('Joaquin'), []);
  assert.deepEqual(names('Pedro Infante'), []);
});

test('RFC and CURP are looked up in the list ids and OFAC notes', () => {
  assert.ok(isIdentifierQuery('GULJ570404HSLZRQ02'));
  assert.ok(isIdentifierQuery('aaa080808hl8'));
  assert.ok(!isIdentifierQuery('Luis Ramirez'));
  assert.deepEqual(searchNameIndex(index, 'gulj570404hslzrq02').map((result) => result.name), ['GUZMAN LOERA, Joaquin']);
  assert.deepEqual(searchNameIndex(index, 'AAA080808HL8').map((result) => result.source), ['sat69b']);
  assert.deepEqual(searchNameIndex(index, 'CEJ0101019A1').map((result) => result.source), ['ofac']);
});

test('prepared searches quote the name and add the city only where it helps', () => {
  const groups = preparedSearches('Luis Ramírez', 'Hermosillo');
  const google = groups[0].links[0].href;
  assert.equal(new URL(google).searchParams.get('q'), '"Luis Ramírez" Hermosillo');
  const facebook = groups[1].links.find((link) => link.name === 'Facebook').href;
  assert.equal(new URL(facebook).searchParams.get('q'), '"Luis Ramírez" Hermosillo site:facebook.com');
  const people = groups[2].links.find((link) => link.name === 'Facebook personas').href;
  assert.equal(new URL(people).searchParams.get('q'), 'Luis Ramírez');
});

test('username variants follow given name plus paternal surname', () => {
  assert.deepEqual(usernameVariants('José Luis Ramírez Gómez'), ['joseramirez', 'jose.ramirez', 'jose_ramirez', 'jramirez', 'joseramirezg']);
  assert.deepEqual(usernameVariants('Luis Ramírez'), ['luisramirez', 'luis.ramirez', 'luis_ramirez', 'lramirez', 'ramirezluis']);
  assert.deepEqual(usernameVariants('Luis'), []);
});

test('the tab searches the lists without saving a history and sends variants to Maigret', async (t) => {
  const executed = [];
  const pool = {
    execute: async (sql, values) => {
      executed.push({ sql, values });
      return sql.startsWith('SELECT') ? [[]] : [{ affectedRows: 1 }];
    },
  };
  const lists = {
    initialize: async () => {},
    refreshStale: async () => {},
    getIndex: async () => index,
    status: async () => [{ source: 'ofac', label: 'OFAC', updatedAt: '2026-10-22 10:00', entries: 3, error: null, refreshing: false }],
    refresh: async () => {},
  };
  const enqueued = [];
  let capacity = 10;
  const maigretSearches = {
    enqueue: async (session, search) => {
      if (enqueued.length >= capacity) throw new MaigretQueueFullError();
      enqueued.push({ session, search });
      return 'id';
    },
  };
  const app = express();
  app.set('views', new URL('../views', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-role'];
    req.session = role ? { userId: 5, role, isAdmin: role === 'admin' } : undefined;
    res.locals.currentUser = req.session ? { ...req.session } : undefined;
    next();
  });
  const denueCalls = [];
  let denueRefreshes = 0;
  const denue = {
    initialize: async () => {},
    refreshStale: async () => {},
    refresh: async () => { denueRefreshes++; },
    status: async () => ({ label: 'DENUE', updatedAt: '2026-10-23 10:00', entries: 6000000, error: null, refreshing: false, progress: null }),
    search: async (name, city) => {
      denueCalls.push([name, city]);
      if (name === 'Luis Ramirez') throw new Error('timeout');
      return [{ nombre: 'TACOS JOAQUIN', razonSocial: 'JOAQUIN GUZMAN', actividad: 'Restaurantes', direccion: 'CALLE 5 #10',
        colonia: 'CENTRO', cp: '80000', ubicacion: 'CULIACAN, Culiacán, SINALOA', latitud: '24.8', longitud: '-107.4', inPlace: true }];
    },
  };
  app.use('/nombres', createNombresRouter(pool, { lists, maigretSearches, denue }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/nombres`;

  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/');

  const page = await (await fetch(`${base}?q=${encodeURIComponent('Joakin Gusman')}&ciudad=Culiacan`, { headers: { 'x-role': 'uecs' } })).text();
  assert.ok(page.includes('GUZMAN LOERA, Joaquin'));
  assert.ok(page.includes('aproximada'));
  assert.ok(page.includes('site%3Afacebook.com'));
  assert.ok(!page.includes('Búsquedas recientes'));
  assert.ok(page.includes('TACOS JOAQUIN'));
  assert.ok(page.includes('Razón social: <strong>JOAQUIN GUZMAN</strong>'));
  assert.ok(page.includes('24.8%2C-107.4'));
  assert.deepEqual(denueCalls, [['Joakin Gusman', 'Culiacan']]);

  const failed = await (await fetch(`${base}?q=Luis+Ramirez`, { headers: { 'x-role': 'uecs' } })).text();
  assert.ok(failed.includes('No se pudo consultar DENUE'));
  assert.ok(failed.includes('RAMÍREZ GÓMEZ LUIS'));

  await fetch(`${base}?q=AAA080808HL8`, { headers: { 'x-role': 'uecs' } });
  assert.equal(denueCalls.length, 2);
  assert.deepEqual(executed, []);

  const short = await (await fetch(`${base}?q=Joaquin`, { headers: { 'x-role': 'usuario' } })).text();
  assert.ok(short.includes('Escribe al menos nombre y apellido'));

  assert.equal((await fetch(`${base}/actualizar`, { method: 'POST', headers: { 'x-role': 'usuario' } })).status, 403);
  assert.equal((await fetch(`${base}/actualizar-denue`, { method: 'POST', headers: { 'x-role': 'usuario' } })).status, 403);
  await fetch(`${base}/actualizar-denue`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'admin' } });
  assert.equal(denueRefreshes, 1);

  const sent = await fetch(`${base}/maigret`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'uecs', 'content-type': 'application/x-www-form-urlencoded' }, body: 'nombre=Luis+Ram%C3%ADrez+G%C3%B3mez' });
  assert.match(new URL(sent.headers.get('location'), base).searchParams.get('message'), /Se enviaron 5/);
  assert.deepEqual(enqueued.map(({ search }) => search), ['luisramirez', 'luis.ramirez', 'luis_ramirez', 'lramirez', 'luisramirezg']
    .map((username) => ({ username, mode: 'rapida', recursive: false })));
  assert.equal(enqueued[0].session.role, 'uecs');

  capacity = 7;
  const partial = await fetch(`${base}/maigret`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'uecs', 'content-type': 'application/x-www-form-urlencoded' }, body: 'nombre=Luis+Ramirez' });
  assert.match(new URL(partial.headers.get('location'), base).searchParams.get('message'), /se enviaron 2 de 5/);
});

// Builds a ZIP like INEGI's: each entry deflated, followed by the central directory.
const zipOf = (entries) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = zlib.deflateRawSync(Buffer.from(text, 'latin1'));
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(fileName.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(8, 10); header.writeUInt32LE(data.length, 20);
    header.writeUInt16LE(fileName.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    central.push(header, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const DENUE_CSV = [
  '"id","nom_estab","raz_social","nombre_act","per_ocu","tipo_vial","nom_vial","numero_ext","letra_ext","numero_int","letra_int","tipo_asent","nomb_asent","cod_postal","cve_ent","entidad","municipio","localidad","telefono","correoelec","www","latitud","longitud"',
  '"1","HOME CEL","OSCR GARCIA NAVARRETE","Comercio de teléfonos","0 a 5 personas","CALLE","REFORMA","120","A",,,"COLONIA","CENTRO","83000","26","Sonora","Hermosillo","Hermosillo   ","6621234567",,,"29.0729","-110.9559"',
  '"2","PINTURAS ""LA ÑAPA""",,"Comercio de pintura","6 a 10 personas","AVENIDA","SERDAN\r\nNORTE",,,,,,,"83000","26","Sonora","Hermosillo","Hermosillo",,,,"",""',
  '"3",,,"Sin nombre","0 a 5 personas",,,,,,,,,,"26","Sonora","Hermosillo","Hermosillo",,,,,',
].join('\r\n');

test('DENUE rows come out of the ZIP in Latin-1, including quoted fields across lines', async () => {
  const zip = zipOf([['diccionario_de_datos/denue_diccionario_de_datos.csv', 'x'], ['conjunto_de_datos/denue_inegi_26_.csv', DENUE_CSV]]);
  const rows = [];
  for await (const row of csvRows(zipEntryStream(zip, /conjunto_de_datos\/.*\.csv$/))) rows.push(row);
  assert.equal(rows.length, 4);
  const header = rows[0];
  const first = toBusiness(header, rows[1]);
  assert.deepEqual(first.slice(0, 8), [1, 'HOME CEL', 'OSCR GARCIA NAVARRETE', 'Comercio de teléfonos', '0 a 5 personas', 'CALLE REFORMA #120A', 'COLONIA CENTRO', '83000']);
  assert.deepEqual(first.slice(-3), [29.0729, -110.9559, 'home cel oscr garcia navarrete']);
  const second = toBusiness(header, rows[2]);
  assert.equal(second[1], 'PINTURAS "LA ÑAPA"');
  assert.equal(second[5], 'AVENIDA SERDAN\nNORTE');
  assert.deepEqual(second.slice(-3), [null, null, 'pinturas la napa']);
  assert.equal(toBusiness(header, rows[3]), null);
  assert.throws(() => zipEntryStream(Buffer.from('<!DOCTYPE html><html><body>no encontrado</body></html>'), /csv$/), /no es un ZIP/);
});

test('DENUE full-text query requires every indexable word and the state written in the place', () => {
  assert.equal(fulltextQuery(['oscar', 'de', 'la', 'garcia', 'j']), '+oscar +garcia');
  assert.equal(fulltextQuery(['de', 'la']), '');
  assert.equal(stateCodeFor('Hermosillo, Sonora'), '26');
  assert.equal(stateCodeFor('La Paz, Baja California Sur'), '03');
  assert.equal(stateCodeFor('Hermosillo'), '00');
});

test('DENUE loads every file into a new table, swaps it in and searches by every word', async () => {
  const queries = [];
  const status = [];
  const connection = {
    query: async (sql, values) => { queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values }); return [[]]; },
    release: () => {},
  };
  const pool = {
    getConnection: async () => connection,
    query: async (sql, values) => {
      status.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      if (!sql.includes('MATCH')) return [[]];
      return [[
        { id: 7, nombre: 'PINTURAS GARCIA', razon_social: '', localidad: 'Nogales', municipio: 'Nogales', entidad: 'Sonora',
          busqueda: 'pinturas garcia', latitud: null, longitud: null },
        { id: 1, nombre: 'HOME CEL', razon_social: 'OSCR GARCIA NAVARRETE', localidad: 'Hermosillo', municipio: 'Hermosillo', entidad: 'Sonora',
          busqueda: 'home cel oscr garcia navarrete', latitud: '29.0729000', longitud: '-110.9559000' },
      ]];
    },
  };
  let attempts = 0;
  const fetchImpl = async (url) => {
    attempts++;
    if (url.endsWith('denue_15_1_csv.zip') && attempts === 1) throw new Error('timeout');
    return new Response(zipOf([['conjunto_de_datos/denue.csv', DENUE_CSV]]));
  };
  const directory = createDenueDirectory(pool, { fetchImpl, files: ['15_1', '26'], minimumPerFile: 1 });
  await directory.refresh();
  assert.equal(attempts, 3);
  const inserts = queries.filter((query) => query.sql.startsWith('INSERT'));
  assert.equal(inserts.length, 2);
  assert.ok(inserts.every((query) => query.sql.includes('denue_negocios_nuevo') && query.values[0].length === 2));
  assert.ok(queries.some((query) => query.sql === 'ALTER TABLE denue_negocios_nuevo ADD FULLTEXT INDEX denue_busqueda (busqueda)'));
  assert.ok(queries.some((query) => query.sql === 'RENAME TABLE denue_negocios TO denue_negocios_anterior, denue_negocios_nuevo TO denue_negocios'));
  assert.deepEqual(status.find((query) => query.sql.startsWith('UPDATE')).values, [4, 'denue']);

  const results = await directory.search('Oscr García', 'Hermosillo, Sonora');
  const match = status.find((query) => query.sql.includes('MATCH'));
  assert.deepEqual(match.values, ['+oscr +garcia', '26', 'hermosillo', 'hermosillo']);
  assert.match(match.sql, /AND cve_ent = \? ORDER BY \(municipio = \? OR localidad = \?\) DESC LIMIT 500/);
  assert.deepEqual(results.map((result) => [result.id, result.ubicacion, result.inPlace]), [['1', 'Hermosillo, Sonora', true]]);
  assert.equal(results[0].latitud, '29.0729000');
  assert.deepEqual(await directory.search('de la'), []);
});

test('a DENUE load that fails keeps the previous table and records the error', async () => {
  const queries = [];
  const pool = {
    getConnection: async () => ({ query: async (sql) => { queries.push(sql); return [[]]; }, release: () => {} }),
    query: async (sql, values) => { queries.push(sql + JSON.stringify(values ?? [])); return [[]]; },
  };
  const fetchImpl = async () => new Response('<!DOCTYPE html><html></html>');
  await assert.rejects(createDenueDirectory(pool, { fetchImpl, files: ['15'] }).refresh(), /no llegó como ZIP/);
  assert.ok(queries.includes('DROP TABLE IF EXISTS denue_negocios_nuevo'));
  assert.ok(!queries.some((sql) => sql.startsWith('RENAME')));
  assert.ok(queries.some((sql) => sql.includes('error_message = ?') && sql.includes('no llegó como ZIP')));
});
