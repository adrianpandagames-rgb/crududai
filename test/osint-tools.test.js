import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import {
  buildHoleheArgs, buildIgnorantArgs, buildSherlockArgs, emailAlias, isValidEmail, isValidPhone, mergeSherlockAccounts,
  parseHoleheCsv, parseIgnorantOutput, parseSherlockCsv,
} from '../src/osintTools.js';
import { runOsintSearch, SEARCH_TYPES } from '../src/maigretService.js';
import { createMaigretRouter } from '../src/maigretRouter.js';
import { createMaigretPdf } from '../src/maigretPdf.js';

test('e-mails and phones can never be read as command-line options', () => {
  for (const email of ['juan.perez88@gmail.com', 'a+tag@sub.dominio.mx', 'x_1@a.io']) assert.ok(isValidEmail(email), email);
  for (const email of ['-x@a.com', '--help@a.com', 'sin-arroba.com', 'a@b', 'a b@c.com', `${'a'.repeat(250)}@b.com`]) assert.ok(!isValidEmail(email), email);
  assert.ok(isValidPhone('6621234567'));
  assert.ok(!isValidPhone('-1234567') && !isValidPhone('123'));
  assert.equal(emailAlias('juan.perez88+trabajo@gmail.com'), 'juan.perez88');
  assert.equal(emailAlias('ñandú@gmail.com'), null);
  assert.equal(buildHoleheArgs('a@b.com')[0], 'a@b.com');
  assert.ok(buildHoleheArgs('a@b.com').includes('--no-password-recovery'));
  assert.deepEqual(buildIgnorantArgs('52', '6621234567').slice(0, 2), ['52', '6621234567']);
  assert.equal(buildSherlockArgs('soxoj')[0], 'soxoj');
  // Both tools pass --timeout to httpx as text, which makes every check fail at once.
  assert.ok(!buildHoleheArgs('a@b.com').includes('--timeout') && !buildIgnorantArgs('52', '1234567').includes('--timeout'));
});

test('Sherlock, Holehe and Ignorant outputs are read into accounts', () => {
  assert.deepEqual(parseSherlockCsv([
    'username,name,url_main,url_user,exists,http_status,response_time_s',
    'soxoj,GitHub,https://github.com/,https://github.com/soxoj,Claimed,200,0.4',
    'soxoj,Bad,https://bad/,javascript:alert(1),Claimed,200,0.1',
    'soxoj,Twitter,https://x.com/,https://x.com/soxoj,Available,404,0.2',
  ].join('\n')), [{ site: 'GitHub', url: 'https://github.com/soxoj' }, { site: 'Bad', url: null }]);

  const holehe = parseHoleheCsv([
    'name,domain,method,frequent_rate_limit,rateLimit,exists,emailrecovery,phoneNumber,others',
    'instagram,instagram.com,register,True,False,True,None,None,None',
    'twitter,twitter.com,register,False,False,True,j*****@gmail.com,+52 *** *** **67,None',
    'spotify,spotify.com,register,False,True,False,None,None,None',
    'discord,discord.com,register,False,False,False,None,None,None',
  ].join('\n'));
  assert.deepEqual(holehe.accounts.map((account) => account.site), ['instagram.com', 'twitter.com']);
  assert.deepEqual(holehe.accounts[1].fields.map(({ key, value }) => `${key}: ${value}`), ['Correo de recuperación: j*****@gmail.com', 'Teléfono asociado: +52 *** *** **67']);
  assert.deepEqual(holehe.unverified, ['spotify.com']);

  const ignorant = parseIgnorantOutput('\u001b[32m[+] amazon.com\u001b[0m\n[+] instagram.com\n[x] snapchat.com\n[+] Phone number used, [-] Phone number not used\n3 websites checked');
  assert.deepEqual(ignorant.accounts.map((account) => account.site), ['amazon.com']);
  // Instagram says "registered" for any number, so it never counts as a registration.
  assert.deepEqual(ignorant.unverified, ['instagram.com', 'snapchat.com']);
  assert.equal(ignorant.checked, 3);
});

test('accounts found by Maigret and Sherlock are confirmed, the rest stay possible', () => {
  const maigret = [
    { username: 'soxoj', site: 'GitHubGist [GitHub]', url: 'https://gist.github.com/soxoj', tags: [], similar: false, fields: [] },
    { username: 'soxoj', site: 'Reddit', url: 'https://www.reddit.com/user/soxoj', tags: [], similar: false, fields: [] },
    { username: 'soxoj', site: 'Habr', url: 'https://habr.com/soxoj', tags: [], similar: false, fields: [] },
    { username: 'soxoj1', site: 'GitHub', url: 'https://github.com/soxoj1', tags: [], similar: false, fields: [] },
  ];
  const sherlock = [
    { site: 'GitHubGist', url: 'https://gist.github.com/soxoj/' },
    { site: 'reddit', url: 'https://reddit.com/user/soxoj' },
    { site: 'Keybase', url: 'https://keybase.io/soxoj' },
  ];
  const merged = mergeSherlockAccounts(maigret, sherlock, 'soxoj');
  assert.deepEqual(merged.map(({ site, sources }) => `${site}:${sources.join('+')}`), [
    'GitHubGist [GitHub]:maigret+sherlock', 'Reddit:maigret+sherlock', 'Habr:maigret', 'Keybase:sherlock', 'GitHub:maigret',
  ]);
});

test('each search type runs its own tools, and one engine failing keeps the other', async () => {
  const calls = [];
  const tools = {
    runMaigret: async () => { calls.push('maigret'); return { accounts: [{ username: 'u', site: 'A', url: null, tags: [], similar: false, fields: [] }], usernames: ['u'], reportHtml: '<p/>', truncated: false }; },
    runSherlock: async () => { calls.push('sherlock'); throw new Error('sin red'); },
    runHolehe: async ({ email }) => { calls.push(`holehe ${email}`); return { accounts: [{ site: 'x.com', url: 'https://x.com', fields: [], sources: ['holehe'] }], unverified: ['y.com'] }; },
    runIgnorant: async ({ countryCode, phone }) => { calls.push(`ignorant ${countryCode} ${phone}`); return { accounts: [], unverified: [] }; },
  };
  const user = await runOsintSearch({ type: 'usuario', username: 'u', mode: 'rapida', recursive: true }, tools);
  assert.deepEqual(user.accounts[0].sources, ['maigret']);
  assert.equal(user.crossChecked, false);
  assert.match(user.notes[0], /Sherlock no pudo completarse: sin red/);

  const email = await runOsintSearch({ type: 'correo', username: 'a@b.com' }, tools);
  assert.equal(email.accounts[0].username, 'a@b.com');
  assert.deepEqual(email.unverified, ['y.com']);
  await runOsintSearch({ type: 'telefono', username: '+52 6621234567', countryCode: '52', phone: '6621234567' }, tools);
  assert.deepEqual(calls, ['maigret', 'sherlock', 'holehe a@b.com', 'ignorant 52 6621234567']);

  await assert.rejects(runOsintSearch({ type: 'usuario', username: 'u' }, {
    ...tools, runMaigret: async () => { throw new Error('maigret caído'); },
  }), /maigret caído/);
});

test('the form validates e-mails and phones and queues the e-mail alias as a username search', async (t) => {
  const queued = [];
  const searches = {
    initialize: async () => {},
    enqueue: async (session, request) => { queued.push(request); return `id-${queued.length}`; },
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { userId: 1, role: 'usuario' }; next(); });
  app.use('/maigret', createMaigretRouter({}, { searches }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = async (body) => decodeURIComponent((await fetch(`http://127.0.0.1:${server.address().port}/maigret/buscar`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  })).headers.get('location'));

  assert.match(await post({ tipo: 'correo', correo: '--help@a.com' }), /type=error.*tipo=correo/);
  assert.match(await post({ tipo: 'telefono', lada: '52', telefono: '12' }), /type=error/);
  assert.equal(queued.length, 0);

  assert.match(await post({ tipo: 'correo', correo: ' Juan.Perez88@Gmail.com ', alias: '1' }), /type=success/);
  assert.deepEqual(queued.map(({ type = 'usuario', username }) => `${type}:${username}`), ['usuario:juan.perez88', 'correo:juan.perez88@gmail.com']);
  assert.equal(queued[1].aliasSearchId, 'id-1');

  await post({ tipo: 'telefono', lada: '+52', telefono: '662 123 4567' });
  assert.deepEqual([queued[2].username, queued[2].countryCode, queued[2].phone], ['+52 6621234567', '52', '6621234567']);
});

const viewsDir = fileURLToPath(new URL('../views/', import.meta.url));
const render = (page, data) => ejs.renderFile(`${viewsDir}pages/${page}.ejs`, {
  currentUser: { isAdmin: false, role: 'usuario' }, currentPath: '/maigret', ...data,
});

test('result pages show confidence for usernames and registrations for e-mails', async () => {
  const base = { id: 'x', mode: 'rapida', recursiveSearch: 1, status: 'listo', error: null, hasReport: 0, requestedBy: 'a@b.mx', createdAt: '', finishedAt: '' };
  const modes = { rapida: { label: 'Rápida (100 sitios)' } };
  const user = await render('maigret-resultado', {
    search: { ...base, type: 'usuario', username: 'soxoj', accounts: 2 }, modes, types: SEARCH_TYPES,
    groups: [{ username: 'soxoj', accounts: [
      { site: 'GitHub', url: 'https://github.com/soxoj', tags: [], fields: [], sources: ['maigret', 'sherlock'] },
      { site: 'Keybase', url: 'https://keybase.io/soxoj', tags: [], fields: [], sources: ['sherlock'] },
    ] }],
    extras: { crossChecked: true, unverified: [], notes: [], aliasSearchId: null },
  });
  assert.match(user, /1 confirmada\(s\) por ambos motores/);
  assert.match(user, /class="maigret-badge confirmed"[^>]*>Confirmado</);
  assert.match(user, /Solo Sherlock/);

  const email = await render('maigret-resultado', {
    search: { ...base, type: 'correo', username: 'juan@gmail.com', accounts: 1 }, modes, types: SEARCH_TYPES,
    groups: [{ username: 'juan@gmail.com', accounts: [{ site: 'twitter.com', url: 'https://twitter.com', tags: [], fields: [{ key: 'Teléfono asociado', value: '+52 ** 67' }], sources: ['holehe'] }] }],
    extras: { crossChecked: null, unverified: ['spotify.com'], notes: [], aliasSearchId: 'abc' },
  });
  assert.match(email, /CORREO · juan@gmail.com/);
  assert.doesNotMatch(email, /Confianza/);
  assert.match(email, /No se pudieron verificar.*spotify\.com/s);
  assert.match(email, /href="\/maigret\/abc">ver la búsqueda de @juan</);

  const legacy = await render('maigret-resultado', {
    search: { ...base, type: 'usuario', username: 'viejo', accounts: 0 }, modes, types: SEARCH_TYPES, groups: [],
    extras: { crossChecked: null, unverified: [], notes: [], aliasSearchId: null },
  });
  assert.doesNotMatch(legacy, /Confianza/);

  const list = await render('maigret', {
    searches: [{ id: '1', type: 'correo', username: 'x@y.com', mode: 'correo', status: 'listo', accounts: 3, createdAt: '' }],
    modes, types: SEARCH_TYPES, selectedType: 'telefono', message: '', messageType: '',
  });
  assert.match(list, /name="lada"/);
  assert.match(list, /type-correo/);
  assert.match(list, /data-confirm="¿Eliminar la búsqueda de x@y.com\?"/);
  assert.doesNotMatch(list, /onsubmit=/);
});

test('the PDF names the kind of search', async () => {
  const pdf = await createMaigretPdf({
    search: { type: 'telefono', username: '+52 6621234567', requestedBy: 'a@b.mx', createdAt: '', finishedAt: '', accounts: 1, error: null },
    groups: [{ username: '+52 6621234567', accounts: [{ site: 'instagram.com', url: 'https://instagram.com', fields: [], sources: ['ignorant'] }] }],
    modeLabel: 'telefono', extras: { unverified: ['snapchat.com'], notes: [] },
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});
