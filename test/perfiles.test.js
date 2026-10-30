import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { createPerfilesStore, extractTitular, isPhoneQuery, readXlsxSheets, validarPerfil } from '../src/perfilesService.js';
import { createPerfilesRouter } from '../src/perfilesRouter.js';

const NO_RECORD = 'Me permito informar a esa H. Autoridad que se ha realizado búsqueda en la base de datos de mi representada en relación al domicilio y/o usuario relacionado al número telefónico, tal y como lo indica en oficio al rubro citado, informando que NO SE ENCONTRÓ REGISTRO RELACIONADO A ESTA LÍNEA.';

const xlsxOf = (...sheets) => {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((rows, index) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), `Hoja${index + 1}`));
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

test('the holder comes from a Nombre or Dirección row, beside, after a colon or below the label', () => {
  assert.deepEqual(extractTitular([[['Línea', '6621234567'], ['Nombre', 'Juan Pérez López'], ['Dirección:', '', 'Calle 5 #10, Centro']]]),
    { nombre: 'Juan Pérez López', direccion: 'Calle 5 #10, Centro' });
  assert.deepEqual(extractTitular([[['NOMBRE: MARÍA RUIZ'], ['DOMICILIO: AV. REFORMA 120']]]),
    { nombre: 'MARÍA RUIZ', direccion: 'AV. REFORMA 120' });
  assert.deepEqual(extractTitular([[['Nombre', 'Dirección', 'Línea', 'Compañía', 'Fecha'], ['ANA SOTO', 'CALLE 1', '662', 'Telcel', '01/01/26']]]),
    { nombre: 'ANA SOTO', direccion: 'CALLE 1' });
  assert.deepEqual(extractTitular([[['contactos'], ['6621111111']], [['Titular', 'LUIS RAMOS']]]), { nombre: 'LUIS RAMOS', direccion: '' });
  assert.equal(extractTitular([[['contactos'], ['6621111111']]]), null);
});

test('the carrier "no record" answer is skipped, but the other field is still taken', () => {
  assert.equal(extractTitular([[['Nombre', NO_RECORD], ['Dirección', NO_RECORD]]]), null);
  // Telcel's layout: holder data above the call records, whose "contactos" column holds no numbers.
  assert.deepEqual(extractTitular([[
    ['Linea: 6624287887 con periodo de busqueda del 21/10/2026 al 24/10/2026'],
    ['Nombre:', 'ROBERTO AGUIRRE PRECIADO'],
    ['Dirección:', NO_RECORD],
    ['Plataforma:', 'PREPAGO'],
    ['Telefono', 'Tipo', 'Numero A', 'Numero B', 'Fecha', 'Hora', 'IMEI', 'LATITUD', 'LONGITUD', 'Azimuth', 'contactos'],
    ['6624287887', 'DATOS', '6624287887', 'ims', '21/10/2026', '00:01:13', '35921865695085', '29°7\'34.89"', '111°2\'26.76W', '155', 'ims'],
  ]]), { nombre: 'ROBERTO AGUIRRE PRECIADO', direccion: '' });
});

test('Excel files are read on every sheet and profiles need a name and a line', () => {
  const sheets = readXlsxSheets(xlsxOf([['contactos'], ['6621111111']], [['Nombre', 'Juan Pérez']]));
  assert.equal(sheets.length, 2);
  assert.deepEqual(extractTitular(sheets), { nombre: 'Juan Pérez', direccion: '' });
  assert.match(validarPerfil({ nombre: ' ', linea: '662' }).error, /nombre/);
  assert.match(validarPerfil({ nombre: 'Juan', linea: '' }).error, /línea/);
  assert.deepEqual(validarPerfil({ nombre: ' Juan  Pérez ', direccion: '', alias: ' @juanp  Telegram ', linea: '662 123 4567' }).perfil,
    { nombre: 'Juan Pérez', direccion: '', alias: '@juanp Telegram', linea: '662 123 4567' });
  assert.match(validarPerfil({ nombre: 'Juan', alias: 'x'.repeat(501), linea: '662' }).error, /alias OSINT/);
  assert.ok(isPhoneQuery('(662) 123-4567'));
  assert.ok(!isPhoneQuery('Juan Pérez') && !isPhoneQuery('123'));
});

test('profiles are kept per group, searched by name or line and not repeated from the same file', async () => {
  const rows = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      if (sql.startsWith('INSERT')) {
        const [nombre, direccion, linea, lineaDigitos, origen, userId, group, alias] = values;
        rows.push({ id: rows.length + 1, nombre, direccion, alias, linea, lineaDigitos, origen, userId, group });
        return [{ insertId: rows.length }];
      }
      if (sql.startsWith('SELECT nombre')) return [rows.filter((row) => row.lineaDigitos === values[0] && row.group === values[1])];
      const visible = sql.includes('owner_group = ?') ? rows.filter((row) => row.group === values[0]) : rows;
      if (sql.includes('LIKE')) return [visible.filter((row) => row.lineaDigitos.includes(values.at(-1).replace(/%/g, '')))];
      return [visible];
    },
  };
  const store = createPerfilesStore(pool);
  const uecs = { userId: 3, role: 'uecs' };
  const general = { userId: 4, role: 'usuario' };
  await store.create({ nombre: 'Joaquín Guzmán Loera', direccion: 'Culiacán', alias: '@ElChapo701 (Telegram)', linea: '662 123 4567' }, uecs);
  assert.equal(await store.createFromFile({ nombre: 'JOAQUIN GUZMAN LOERA', direccion: '', linea: '6621234567' }, uecs), null);
  assert.equal(await store.createFromFile({ nombre: 'Otra Persona', direccion: '', linea: '6621234567' }, general), 2);
  assert.deepEqual((await store.search('Joakin Gusman', uecs)).map((row) => [row.nombre, row.exact]), [['Joaquín Guzmán Loera', false]]);
  assert.deepEqual(await store.search('Joaquin Guzman', general), []);
  assert.deepEqual((await store.search('@elchapo', uecs)).map((row) => [row.nombre, row.exact]), [['Joaquín Guzmán Loera', true]]);
  assert.deepEqual(await store.search('@elchapo', general), []);
  assert.deepEqual(await store.search('el', uecs), []);
  assert.deepEqual((await store.search('+52 662 123 4567', general)).map((row) => row.nombre), ['Otra Persona']);
  assert.equal((await store.search('Joaquin Guzman', { userId: 1, role: 'admin', isAdmin: true })).length, 1);
});

test('the list is filtered by name, alias or line and paged in SQL', async () => {
  const calls = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      calls.push({ sql, values });
      return sql.startsWith('SELECT COUNT') ? [[{ total: 23 }]] : [[{ id: 1, nombre: 'Ana', imagenIds: '4,5' }]];
    },
  };
  const store = createPerfilesStore(pool);
  const admin = { userId: 1, role: 'admin', isAdmin: true };
  assert.deepEqual(await store.list(admin, { search: ' 50%_ 662-12 ', page: 3, pageSize: 10 }),
    { rows: [{ id: 1, nombre: 'Ana', imagenes: [4, 5] }], total: 23 });
  const [count, page] = calls.slice(-2);
  assert.deepEqual(count.values.slice(-3), ['%50\\%\\_ 662-12%', '%50\\%\\_ 662-12%', '%5066212%']);
  assert.match(page.sql, /LIMIT 10 OFFSET 20$/);
  await store.list(admin, { search: 'Ana' });
  assert.ok(!calls.at(-1).sql.includes('linea_digitos LIKE') && calls.at(-1).sql.endsWith('LIMIT 10 OFFSET 0'));
});

test('the tab registers a profile, taking Nombre and Dirección from the Excel unless it reports no record', async (t) => {
  const created = [];
  const images = [];
  const perfiles = {
    list: async (session, { search = '', page = 1, pageSize = 10 } = {}) => {
      const rows = created.map((perfil, index) => ({
        id: index + 1, ...perfil, createdAt: '2026-10-26 10:00',
        imagenes: images.filter((image) => image.perfilId === String(index + 1)).map((image) => image.id),
      })).filter((perfil) => perfil.nombre.toLowerCase().includes(search.toLowerCase()));
      return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
    },
    create: async (perfil, session) => { created.push({ ...perfil, group: session.role }); return created.length; },
    remove: async (id) => (images.some((image) => image.perfilId === id) ? 'con-imagenes' : id === '1' ? 'eliminado' : 'no-encontrado'),
    addImages: async (perfilId, added) => {
      if (perfilId !== '2') return null;
      added.forEach((image) => images.push({ id: images.length + 1, perfilId, ...image }));
      return added.length;
    },
    get: async (id) => (created[id - 1] ? { id, ...created[id - 1] } : null),
    update: async (id, perfil) => {
      if (!created[id - 1]) return false;
      Object.assign(created[id - 1], perfil);
      return true;
    },
    getImage: async (id) => (id === '1' ? { mime: 'image/png', data: images[0].buffer } : null),
    removeImage: async (id) => {
      const index = images.findIndex((image) => String(image.id) === id);
      if (index < 0) return null;
      const [removed] = images.splice(index, 1);
      return Number(removed.perfilId);
    },
    removeAllImages: async (perfilId) => {
      if (!created[perfilId - 1]) return null;
      const before = images.length;
      images.splice(0, images.length, ...images.filter((image) => image.perfilId !== perfilId));
      return before - images.length;
    },
  };
  const app = express();
  app.set('views', fileURLToPath(new URL('../views', import.meta.url)));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-role'];
    req.session = role ? { userId: 5, role } : undefined;
    res.locals.currentUser = req.session;
    next();
  });
  app.use('/perfiles', createPerfilesRouter(null, { perfiles }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/perfiles`;
  const post = (fields, file) => {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => body.append(key, value));
    if (file) body.append('archivo', new Blob([file]), 'respuesta.xlsx');
    return fetch(base, { method: 'POST', body, redirect: 'manual', headers: { 'x-role': 'uecs' } });
  };

  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/');

  const typed = await post({ nombre: 'Luis Ramírez', direccion: 'Centro', alias: '@luisr en Telegram', linea: '6620000000' });
  assert.match(new URL(typed.headers.get('location'), base).searchParams.get('message'), /registrado/);

  const fromFile = await post({ nombre: 'Escrito', linea: '6621234567' }, xlsxOf([['Nombre', 'JUAN PÉREZ'], ['Dirección', 'CALLE 5']]));
  assert.match(new URL(fromFile.headers.get('location'), base).searchParams.get('message'), /datos del archivo/);

  const noRecord = await post({ nombre: 'Escrito a mano', linea: '6629999999' }, xlsxOf([['Nombre', NO_RECORD]]));
  assert.match(new URL(noRecord.headers.get('location'), base).searchParams.get('message'), /no se encontró registro/);

  const missing = await post({ linea: '6628888888' }, xlsxOf([[NO_RECORD]]));
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /id="nombre" name="nombre" class="form-control is-invalid"[^>]*aria-invalid="true"/);

  // A file that is not Excel keeps what was typed instead of redirecting and losing it.
  const notExcel = new FormData();
  Object.entries({ nombre: 'Tecleado', linea: '6627777777' }).forEach(([key, value]) => notExcel.append(key, value));
  notExcel.append('archivo', new Blob(['texto']), 'notas.txt');
  const rejected = await fetch(base, { method: 'POST', body: notExcel, redirect: 'manual', headers: { 'x-role': 'uecs' } });
  assert.equal(rejected.status, 400);
  const rejectedPage = await rejected.text();
  assert.ok(rejectedPage.includes('debe ser Excel') && rejectedPage.includes('value="Tecleado"') && rejectedPage.includes('value="6627777777"'));

  assert.deepEqual(created.map(({ nombre, direccion, group }) => [nombre, direccion, group]), [
    ['Luis Ramírez', 'Centro', 'uecs'], ['JUAN PÉREZ', 'CALLE 5', 'uecs'], ['Escrito a mano', '', 'uecs'],
  ]);
  const page = await (await fetch(base, { headers: { 'x-role': 'uecs' } })).text();
  assert.ok(page.includes('JUAN PÉREZ') && page.includes('CALLE 5') && page.includes('@luisr en Telegram'));
  const searched = await (await fetch(`${base}?search=nadie`, { headers: { 'x-role': 'uecs' } })).text();
  assert.ok(searched.includes('Ningún perfil coincide con «nadie»') && !searched.includes('CALLE 5'));
  const pastEnd = await fetch(`${base}?page=9&pageSize=10`, { redirect: 'manual', headers: { 'x-role': 'uecs' } });
  assert.equal(pastEnd.headers.get('location'), '/perfiles?page=1&pageSize=10');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const postImages = (id, files) => {
    const body = new FormData();
    files.forEach(([name, buffer]) => body.append('imagenes', new Blob([buffer]), name));
    return fetch(`${base}/${id}/imagenes`, { method: 'POST', body, redirect: 'manual', headers: { 'x-role': 'uecs' } });
  };
  const message = (response) => new URL(response.headers.get('location'), base).searchParams.get('message');
  assert.match(message(await postImages(2, [['foto.png', png], ['otra.png', png]])), /Se agregaron 2 imágenes/);
  assert.match(message(await postImages(2, [['nota.txt', Buffer.from('no es imagen, solo texto')]])), /no es una imagen/);
  assert.match(message(await postImages(9, [['foto.png', png]])), /no fue encontrado/);
  assert.equal(images.length, 2);
  assert.ok((await (await fetch(base, { headers: { 'x-role': 'uecs' } })).text()).includes('/perfiles/imagenes/1'));

  const served = await fetch(`${base}/imagenes/1`, { headers: { 'x-role': 'uecs' } });
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/imagenes/5`, { headers: { 'x-role': 'uecs' } })).status, 404);

  // UECS registers profiles and adds photos, but sees no edit or delete controls and is turned away from those routes.
  const uecsPage = await (await fetch(base, { headers: { 'x-role': 'uecs' } })).text();
  assert.ok(uecsPage.includes('Agregar fotos a JUAN PÉREZ'));
  assert.ok(!/\/editar\?|\/eliminar"|Eliminar foto|Eliminar todas las fotos|<th>Acciones/.test(uecsPage));
  for (const [method, route] of [['GET', '/2/editar'], ['POST', '/2/editar'], ['POST', '/eliminar/1'], ['POST', '/imagenes/1/eliminar'], ['POST', '/2/imagenes/eliminar']]) {
    const denied = await fetch(`${base}${route}`, { method, redirect: 'manual', headers: { 'x-role': 'uecs' } });
    assert.match(message(denied), /no editarlos ni eliminarlos/, `${method} ${route}`);
  }
  assert.equal(images.length, 2);

  // A profile with images stays until they are deleted; its trash button is disabled meanwhile.
  const listPage = await (await fetch(base, { headers: { 'x-role': 'admin' } })).text();
  assert.match(listPage, /aria-label="Eliminar perfil de JUAN PÉREZ: primero elimine sus fotos"/);
  const blocked = await fetch(`${base}/eliminar/2`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'admin' } });
  assert.match(message(blocked), /Elimínelas primero/);
  // Actions return to the profile's row with its photos open, keeping the list's search and page.
  const removed = await fetch(`${base}/imagenes/1/eliminar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ volver: 'search=juan&page=2&pageSize=20&message=x' }),
    headers: { 'x-role': 'admin', 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.match(message(removed), /Imagen eliminada/);
  const back = new URL(removed.headers.get('location'), base);
  assert.deepEqual([back.searchParams.get('search'), back.searchParams.get('page'), back.searchParams.get('pageSize'), back.searchParams.get('abierto'), back.hash],
    ['juan', '2', '20', '2', '#perfil-2']);
  assert.equal(images.length, 1);
  assert.ok((await (await fetch(`${base}?abierto=2`, { headers: { 'x-role': 'admin' } })).text()).includes('<details class="perfil-galeria" open>'));
  assert.match(message(await fetch(`${base}/2/imagenes/eliminar`, { method: 'POST', redirect: 'manual', headers: { 'x-role': 'admin' } })),
    /Se eliminó 1 imagen/);
  assert.equal(images.length, 0);

  assert.ok(listPage.includes('href="/perfiles/2/editar?'));
  const editPage = await (await fetch(`${base}/2/editar`, { headers: { 'x-role': 'admin' } })).text();
  assert.ok(editPage.includes('value="JUAN PÉREZ"') && editPage.includes('CALLE 5</textarea>'));
  assert.match(message(await fetch(`${base}/9/editar`, { redirect: 'manual', headers: { 'x-role': 'admin' } })), /no fue encontrado/);
  const edit = (id, body) => fetch(`${base}/${id}/editar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(body),
    headers: { 'x-role': 'admin', 'content-type': 'application/x-www-form-urlencoded' },
  });
  const invalidEdit = await edit(2, { nombre: '', direccion: 'Otra', linea: '6621234567' });
  assert.equal(invalidEdit.status, 400);
  assert.ok((await invalidEdit.text()).includes('Escriba el nombre'));
  assert.match(message(await edit(2, { nombre: ' Juan  Pérez Ruiz ', direccion: 'Calle 9', alias: 'Juan P (WhatsApp)', linea: '662 123 4567' })), /actualizado/);
  assert.deepEqual([created[1].nombre, created[1].direccion, created[1].alias, created[1].linea],
    ['Juan Pérez Ruiz', 'Calle 9', 'Juan P (WhatsApp)', '662 123 4567']);
  assert.ok((await (await fetch(`${base}/2/editar`, { headers: { 'x-role': 'admin' } })).text()).includes('value="Juan P (WhatsApp)"'));
  assert.match(message(await edit(9, { nombre: 'X', linea: '1' })), /no fue encontrado/);
});

test('a profile with images is not deleted, and images are only deleted by their id', async () => {
  const executed = [];
  const pool = {
    query: async () => [[]],
    execute: async (sql, values) => {
      executed.push(sql.replace(/\s+/g, ' '));
      if (sql.startsWith('DELETE p')) return [{ affectedRows: 0 }];
      if (sql.startsWith('SELECT p.id FROM')) return [[{ id: values[0] }]];
      if (sql.startsWith('SELECT i.perfil_id')) return [[{ perfilId: 4 }]];
      if (sql.startsWith('DELETE FROM perfil_imagenes')) return [{ affectedRows: 3 }];
      return [{ affectedRows: 1 }];
    },
  };
  const store = createPerfilesStore(pool);
  assert.equal(await store.remove('4', { userId: 3, role: 'uecs' }), 'con-imagenes');
  assert.match(executed[0], /NOT EXISTS \(SELECT 1 FROM perfil_imagenes/);
  assert.equal(await store.removeImage('8', { userId: 3, role: 'uecs' }), 4);
  assert.match(executed.at(-1), /DELETE i FROM perfil_imagenes i JOIN perfiles p .* WHERE i.id = \? AND p.owner_group = \?/);
  // Deleting all of a profile's images checks access to the profile first.
  assert.equal(await store.removeAllImages('4', { userId: 3, role: 'uecs' }), 3);
  assert.match(executed.at(-2), /SELECT p.id FROM perfiles p WHERE p.id = \? AND p.owner_group = \?/);
});
