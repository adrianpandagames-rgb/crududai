import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  buildNameIndex, isIdentifierQuery, normalizeName, parseOfac, parseSat69b, phoneticKey,
  preparedSearches, searchNameIndex, usernameVariants, withinOneEdit,
} from '../src/nameSearchService.js';
import { createNombresRouter } from '../src/nombresRouter.js';
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
  app.use('/nombres', createNombresRouter(pool, { lists, maigretSearches }));
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
  assert.deepEqual(executed, []);

  const short = await (await fetch(`${base}?q=Joaquin`, { headers: { 'x-role': 'usuario' } })).text();
  assert.ok(short.includes('Escribe al menos nombre y apellido'));

  assert.equal((await fetch(`${base}/actualizar`, { method: 'POST', headers: { 'x-role': 'usuario' } })).status, 403);

  const sent = await fetch(`${base}/maigret`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'uecs', 'content-type': 'application/x-www-form-urlencoded' }, body: 'nombre=Luis+Ram%C3%ADrez+G%C3%B3mez' });
  assert.match(new URL(sent.headers.get('location'), base).searchParams.get('message'), /Se enviaron 5/);
  assert.deepEqual(enqueued.map(({ search }) => search), ['luisramirez', 'luis.ramirez', 'luis_ramirez', 'lramirez', 'luisramirezg']
    .map((username) => ({ username, mode: 'rapida', recursive: false })));
  assert.equal(enqueued[0].session.role, 'uecs');

  capacity = 7;
  const partial = await fetch(`${base}/maigret`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'uecs', 'content-type': 'application/x-www-form-urlencoded' }, body: 'nombre=Luis+Ramirez' });
  assert.match(new URL(partial.headers.get('location'), base).searchParams.get('message'), /se enviaron 2 de 5/);
});
