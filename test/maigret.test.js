import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildMaigretArgs, isValidUsername, normalizeUsername, parseMaigretReports } from '../src/maigretService.js';
import { createMaigretRouter } from '../src/maigretRouter.js';

test('usernames cannot start with a dash, so they are never read as Maigret options', () => {
  assert.equal(normalizeUsername('  @guero_hmo '), 'guero_hmo');
  for (const name of ['soxoj', 'luis.r_662', 'a-b', '_x']) assert.ok(isValidUsername(name), name);
  for (const name of ['', '-a', '--all-sites', 'dos palabras', 'x/../y', 'a'.repeat(65), 'ñandú']) assert.ok(!isValidUsername(name), name);
});

test('arguments put the username first and disable recursion on request', () => {
  const args = buildMaigretArgs({ username: 'soxoj', mode: 'rapida', recursive: false, outputDir: '/tmp/x' });
  assert.equal(args[0], 'soxoj');
  assert.deepEqual(args.slice(1, 3), ['--top-sites', '100']);
  assert.ok(args.includes('--no-recursion'));
  assert.ok(!buildMaigretArgs({ username: 'soxoj', mode: 'completa', recursive: true, outputDir: '/tmp/x' }).includes('--no-recursion'));
  assert.ok(buildMaigretArgs({ username: 'soxoj', mode: 'completa', recursive: true, outputDir: '/tmp/x' }).includes('--all-sites'));
});

test('reports keep only existing accounts, safe links and visible fields', () => {
  const accounts = parseMaigretReports([
    { username: 'soxoj', data: {
      Bluesky: { username: 'soxoj', url_user: 'https://bsky.app/profile/soxoj.bsky.social', is_similar: false, rank: 184,
        site: { tags: ['social'] },
        status: { status: 'Claimed', site_name: 'Bluesky', url: 'https://bsky.app/profile/soxoj.bsky.social', tags: ['messaging', 'social'],
          ids: { fullname: 'Soxoj', image: 'https://cdn.bsky.app/a.jpg', _extractor: 'Bluesky API', bio: '' } } },
      StackOverflow: { username: 'soxoj', url_user: 'javascript:alert(1)', is_similar: true, rank: 178,
        status: { status: 'Claimed', site_name: 'StackOverflow', url: 'javascript:alert(1)', ids: {} } },
      Twitter: { username: 'soxoj', status: { status: 'Available', site_name: 'Twitter' } },
    } },
    { username: 'Soxoj1', data: {
      GitHubGist: { username: 'Soxoj1', url_user: 'https://gist.github.com/Soxoj1', status: { status: 'Claimed', site_name: 'GitHubGist [GitHub]' } },
    } },
  ]);
  assert.deepEqual(accounts.map((account) => account.site), ['StackOverflow', 'Bluesky', 'GitHubGist [GitHub]']);
  const [stack, bluesky, gist] = accounts;
  assert.equal(stack.url, null);
  assert.equal(stack.similar, true);
  assert.deepEqual(bluesky.tags, ['messaging', 'social']);
  assert.deepEqual(bluesky.fields, [
    { key: 'fullname', value: 'Soxoj', isLink: false },
    { key: 'image', value: 'https://cdn.bsky.app/a.jpg', isLink: true },
  ]);
  assert.equal(gist.username, 'Soxoj1');
});

test('searches are queued per group and each group only sees its own searches', async (t) => {
  const executed = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      executed.push({ sql, values });
      if (sql.startsWith('SELECT m.search_uuid AS id, m.username, m.mode')) return [[]];
      if (sql.startsWith('DELETE')) return [{ affectedRows: 0 }];
      return [{ affectedRows: 1 }];
    },
  };
  let finishSearch;
  const runs = [];
  const runSearch = (options) => {
    runs.push(options);
    return new Promise((resolve) => { finishSearch = resolve; });
  };
  const app = express();
  app.set('views', new URL('../views', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-role'];
    req.session = role ? { userId: 4, role, isAdmin: role === 'admin' } : undefined;
    res.locals.currentUser = req.session ? { ...req.session } : undefined;
    next();
  });
  app.use('/maigret', createMaigretRouter(pool, { runSearch }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/maigret`;
  const post = (path, body, role) => fetch(base + path, {
    method: 'POST', redirect: 'manual', headers: { 'x-role': role, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/');

  const rejected = await post('/buscar', { usuario: '--all-sites', modo: 'rapida' }, 'uecs');
  assert.match(decodeURIComponent(rejected.headers.get('location')), /type=error/);
  assert.equal(runs.length, 0);

  const accepted = await post('/buscar', { usuario: '@guero_hmo', modo: 'normal', recursivo: '1' }, 'uecs');
  assert.match(decodeURIComponent(accepted.headers.get('location')), /type=success/);
  const insert = executed.find(({ sql }) => sql.startsWith('INSERT INTO maigret_busquedas'));
  assert.deepEqual(insert.values.slice(1), [4, 'uecs', 'guero_hmo', 'normal', 1]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].username, 'guero_hmo');
  finishSearch({ accounts: [{ username: 'guero_hmo', site: 'X', url: null, tags: [], similar: false, fields: [] }], usernames: ['guero_hmo'], reportHtml: '<p>r</p>', truncated: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const saved = executed.find(({ sql }) => sql.includes("status = 'listo'"));
  assert.equal(saved.values[0], 1);

  for (const [role, expected] of [['uecs', ['uecs']], ['usuario', ['general']], ['admin', []]]) {
    executed.length = 0;
    assert.equal((await fetch(base, { headers: { 'x-role': role } })).status, 200);
    const list = executed.find(({ sql }) => sql.startsWith('SELECT m.search_uuid AS id, m.username, m.mode'));
    assert.deepEqual(list.values, expected, role);
  }

  assert.equal((await fetch(`${base}/no-es-un-id`, { headers: { 'x-role': 'usuario' } })).status, 404);
});
