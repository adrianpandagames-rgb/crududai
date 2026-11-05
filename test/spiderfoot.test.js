import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import {
  STOP_REASON, buildSpiderfootArgs, describeEventType, parseSpiderfootOutput, parseTarget,
} from '../src/spiderfootService.js';
import { createSpiderfootRouter, createSpiderfootSearches, groupEvents } from '../src/spiderfootRouter.js';

test('each kind of target is checked and passed with the type SpiderFoot expects', () => {
  const ok = (type, body, target, targetType) => assert.deepEqual(
    (({ target: t, targetType: tt }) => ({ target: t, targetType: tt }))(parseTarget(type, body)), { target, targetType }, `${type} ${JSON.stringify(body)}`);
  ok('dominio', { objetivo: 'https://WWW.Ejemplo.com.mx/ruta?x=1' }, 'www.ejemplo.com.mx', 'INTERNET_NAME');
  ok('ip', { objetivo: ' 189.203.10.5 ' }, '189.203.10.5', 'IP_ADDRESS');
  ok('ip', { objetivo: '2606:4700:10::AC42:93F3' }, '2606:4700:10::ac42:93f3', 'IPV6_ADDRESS');
  ok('red', { objetivo: '189.203.10.0/24' }, '189.203.10.0/24', 'NETBLOCK_OWNER');
  ok('red', { objetivo: '2606:4700::/48' }, '2606:4700::/48', 'NETBLOCKV6_OWNER');
  ok('asn', { objetivo: 'as 8151' }, '8151', 'BGP_AS_OWNER');
  ok('correo', { objetivo: 'Nombre@Gmail.com' }, 'nombre@gmail.com', 'EMAILADDR');
  ok('telefono', { lada: '+52', telefono: '662 123 4567' }, '+526621234567', 'PHONE_NUMBER');
  // sf.py on its own would take "juan.perez" for a domain; the explicit type keeps it a username.
  ok('usuario', { objetivo: '@juan.perez' }, 'juan.perez', 'USERNAME');
  ok('nombre', { objetivo: '  José   Pérez López ' }, 'José Pérez López', 'HUMAN_NAME');
  ok('bitcoin', { objetivo: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'BITCOIN_ADDRESS');

  assert.equal(parseTarget('asn', { objetivo: '8151' }).shown, 'AS8151');
  assert.equal(parseTarget('usuario', { objetivo: 'guero' }).shown, '@guero');
  // Nothing accepted may start with a dash, or sf.py would read it as an option.
  for (const [type, value] of [['dominio', '-x.com'], ['dominio', 'localhost'], ['ip', '999.1.1.1'], ['red', '10.0.0.0/8'],
    ['red', '10.0.0.0'], ['asn', '-5'], ['correo', '-a@b.com'], ['usuario', '--help'], ['nombre', 'Juan'], ['nombre', '-Juan Pérez'],
    ['bitcoin', 'hola'], ['otro', 'x']]) {
    assert.ok(parseTarget(type, { objetivo: value }).error, `${type} ${value}`);
  }
  assert.ok(parseTarget('telefono', { lada: '0', telefono: '6621234567' }).error);
});

test('a single line of text (the bot) gets its kind of target guessed, or uses the one given', async () => {
  const { detectTargetType, parseTextTarget } = await import('../src/spiderfootService.js');
  for (const [text, type] of [
    ['ejemplo.com', 'dominio'], ['https://ejemplo.com/x', 'dominio'], ['+52 6621234567', 'telefono'], ['@juan.perez', 'usuario'],
    ['a@b.com', 'correo'], ['10.0.0.0/24', 'red'], ['1.2.3.4', 'ip'], ['2606:4700::1', 'ip'], ['AS8151', 'asn'],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'bitcoin'], ['Juan Pérez', 'nombre'], ['guero_hmo', 'usuario'],
  ]) assert.equal(detectTargetType(text), type, text);
  assert.deepEqual(parseTextTarget('+52 662 123 4567'), { type: 'telefono', target: '+526621234567', targetType: 'PHONE_NUMBER', shown: '+52 6621234567' });
  assert.ok(parseTextTarget('+526621234567').error);
  assert.equal(parseTextTarget('juan.perez', 'usuario').targetType, 'USERNAME');
  assert.ok(parseTextTarget('x', 'inventado').error);
});

test('the scan runs the wrapper with the target right after -s and the mode use case', () => {
  const args = buildSpiderfootArgs({ target: 'ejemplo.com', mode: 'rapida' });
  assert.match(args[0], /spiderfoot_scan\.py$/);
  assert.deepEqual(args.slice(1, 5), ['-s', 'ejemplo.com', '-u', 'passive']);
  assert.ok(args.includes('json'));
  assert.ok(buildSpiderfootArgs({ target: 'ejemplo.com', mode: 'completa' }).includes('all'));
});

test('the output is read line by line, so a scan cut off midway still gives its events', () => {
  const output = [
    '[{"generated": 1, "type": "Internet Name", "data": "example.com", "module": "SpiderFoot UI", "source": "example.com"},',
    '{"generated": 1, "type": "IP Address", "data": "104.20.23.154", "module": "sfp_dnsresolve", "source": "example.com"},',
    '{"generated": 1, "type": "IP Address", "data": "104.20.23.154", "module": "sfp_other", "source": "example.com"},',
    '{"generated": 1, "type": "Account on External Site", "data": "GitHub (Category: coding)\\n<SFURL>https://github.com/x</SFURL>", "module": "sfp_accounts", "source": "x"},',
    '{"generated": 1, "type": "Domain Whois", "data": "Domain Name: EXAM',
  ].join('\n');
  const { events, dropped } = parseSpiderfootOutput(output);
  assert.equal(dropped, 0);
  assert.deepEqual(events.map((event) => [event.type, event.module]), [
    ['IP Address', 'dnsresolve'],
    ['Account on External Site', 'accounts'],
  ]);
  assert.equal(events[1].data, 'GitHub (Category: coding)\nhttps://github.com/x');
  assert.equal(parseSpiderfootOutput('{"type": "IP Address", "data": "1.1.1.1", "module": "sfp_x", "source": "y"}]').events.length, 1);
});

test('event types get a Spanish label and a category, and the page groups them in order', () => {
  assert.deepEqual(describeEventType('Hacked Email Address'), { label: 'Correo en filtraciones', category: 'riesgos' });
  assert.deepEqual(describeEventType('Affiliate - IP Address'), { label: 'Relacionado: Dirección IP', category: 'afiliados' });
  assert.equal(describeEventType('Description - Category').category, 'otros');
  assert.equal(describeEventType('Raw Data from RIRs/APIs').category, 'crudos');
  assert.equal(describeEventType('Human Name').category, 'personas');
  assert.equal(describeEventType("Email Gateway (DNS 'MX' Records)").category, 'infraestructura');
  assert.equal(describeEventType('Co-Hosted Site').category, 'infraestructura');
  assert.deepEqual(describeEventType('Something New'), { label: 'Something New', category: 'otros' });

  const groups = groupEvents([
    { type: 'IP Address', data: '1.1.1.1' },
    { type: 'Human Name', data: 'Juan' },
    { type: 'IP Address', data: '2.2.2.2' },
  ]);
  assert.deepEqual(groups.map((group) => [group.key, group.total]), [['personas', 1], ['infraestructura', 2]]);
  assert.equal(groups[1].types[0].events.length, 2);
});

const fakePool = (executed, { results = null } = {}) => ({
  query: async () => [[]],
  execute: async (sql, values) => {
    executed.push({ sql, values });
    if (sql.startsWith('SELECT s.search_uuid AS id, s.search_type')) return [[]];
    if (sql.startsWith('SELECT')) return [results ? [results] : []];
    if (sql.startsWith('DELETE')) return [{ affectedRows: 0 }];
    return [{ affectedRows: 1 }];
  },
});

test('searches are queued per group, rejected targets never run and stopping keeps the partial result', async (t) => {
  const executed = [];
  const runs = [];
  const runSearch = (options) => {
    runs.push(options);
    return new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({
        events: [{ type: 'IP Address', data: '1.1.1.1', module: 'dnsresolve', source: 'ejemplo.com' }],
        notes: [`reason:${options.signal.reason}`], partial: true,
      }));
    });
  };
  const searches = createSpiderfootSearches(fakePool(executed, { results: { search_uuid: 'x' } }), { runSearch });
  const app = express();
  app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-role'];
    req.session = role ? { userId: 4, role, isAdmin: role === 'admin' } : undefined;
    res.locals.currentUser = req.session ? { ...req.session } : undefined;
    next();
  });
  app.use('/spiderfoot', createSpiderfootRouter(fakePool(executed), { searches }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/spiderfoot`;
  const post = (path, body, role) => fetch(base + path, {
    method: 'POST', redirect: 'manual', headers: { 'x-role': role, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/');

  const rejected = await post('/buscar', { tipo: 'dominio', objetivo: '-u all' }, 'uecs');
  assert.match(decodeURIComponent(rejected.headers.get('location')), /type=error/);
  assert.equal(runs.length, 0);

  const accepted = await post('/buscar', { tipo: 'asn', objetivo: 'AS8151', modo: 'normal' }, 'uecs');
  assert.match(decodeURIComponent(accepted.headers.get('location')), /type=success/);
  const insert = executed.find(({ sql }) => sql.startsWith('INSERT INTO spiderfoot_busquedas'));
  assert.deepEqual(insert.values.slice(1), [4, 'uecs', 'asn', '8151', 'AS8151', 'BGP_AS_OWNER', 'normal']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].targetType, 'BGP_AS_OWNER');

  const stop = await post(`/detener/${insert.values[0]}`, {}, 'uecs');
  assert.match(decodeURIComponent(stop.headers.get('location')), /type=success/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const saved = executed.find(({ sql }) => sql.includes("status = 'listo'"));
  assert.equal(saved.values[0], 1);
  assert.deepEqual(JSON.parse(saved.values[1]).notes, [`reason:${STOP_REASON}`]);

  for (const [role, expected] of [['uecs', ['uecs']], ['usuario', ['general']], ['admin', []]]) {
    executed.length = 0;
    assert.equal((await fetch(base, { headers: { 'x-role': role } })).status, 200);
    const list = executed.find(({ sql }) => sql.startsWith('SELECT s.search_uuid AS id, s.search_type'));
    assert.deepEqual(list.values, expected, role);
  }
  assert.equal((await fetch(`${base}/no-es-un-id`, { headers: { 'x-role': 'usuario' } })).status, 404);
});

test('a search stopped while still queued is marked as cancelled instead of staying queued forever', async () => {
  const executed = [];
  let finishFirst;
  const searches = createSpiderfootSearches(fakePool(executed, { results: { search_uuid: 'x' } }), {
    runSearch: () => new Promise((resolve) => { finishFirst = resolve; }),
  });
  const session = { userId: 1, role: 'usuario' };
  await searches.enqueue(session, { type: 'dominio', target: 'a.com', targetType: 'INTERNET_NAME', shown: 'a.com', mode: 'rapida' });
  const second = await searches.enqueue(session, { type: 'dominio', target: 'b.com', targetType: 'INTERNET_NAME', shown: 'b.com', mode: 'rapida' });
  assert.equal(await searches.stop(session, second), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  finishFirst({ events: [], notes: [] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = executed.find(({ sql, values }) => sql.includes('se canceló antes de iniciar') && values[0] === second);
  assert.ok(cancelled);
});

test('the result page links only web URLs, escapes the rest and the CSV neutralizes formulas', async (t) => {
  const html = await ejs.renderFile('views/pages/spiderfoot-resultado.ejs', {
    search: { id: 'x', type: 'dominio', target: 'ejemplo.com', mode: 'rapida', status: 'listo', events: 2, requestedBy: 'a@b.mx', createdAt: '', finishedAt: '' },
    results: { events: [], notes: [], partial: false },
    categories: groupEvents([
      { type: 'Account on External Site', data: 'GitHub <b>x</b>\nhttps://github.com/x', module: 'accounts', source: 'x' },
      { type: 'Linked URL - External', data: 'javascript:alert(1)', module: 'spider', source: 'x' },
    ]),
    modes: (await import('../src/spiderfootService.js')).SPIDERFOOT_MODES,
    types: (await import('../src/spiderfootService.js')).SPIDERFOOT_TYPES,
    message: '', messageType: '', currentUser: { role: 'usuario' }, currentPath: '/spiderfoot/x',
  });
  assert.ok(html.includes('<a href="https://github.com/x"'));
  assert.ok(html.includes('GitHub &lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!html.includes('href="javascript:'));

  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const searches = {
    initialize: async () => {},
    find: async (session, searchId) => (searchId === id ? {
      id, type: 'dominio', target: 'ejemplo.com', mode: 'rapida', status: 'listo', events: 1,
      results: JSON.stringify({ events: [{ type: 'Human Name', data: '=HYPERLINK("x")', module: 'names', source: 'ejemplo.com' }] }),
    } : null),
  };
  const app = express();
  app.use((req, res, next) => { req.session = { userId: 1, role: 'usuario', isAdmin: false }; next(); });
  app.use('/spiderfoot', createSpiderfootRouter({}, { searches }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/spiderfoot/${id}/csv`);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="SpiderFoot-ejemplo.com.csv"');
  const csv = await response.text();
  assert.ok(csv.includes(`Personas, cuentas y contacto`));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});
