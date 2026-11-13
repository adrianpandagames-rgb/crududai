import test from 'node:test';
import assert from 'node:assert/strict';
import { casoIdPara, delitoPara, normalizarDelito } from '../src/casosService.js';

// Unique keys behave like the 0900_ai_ci collation: case and accents do not count.
const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fakeDb = () => {
  const tables = { casos: [], delitos: [] };
  const upsert = (table, row, key) => {
    const found = tables[table].find((existing) => key(existing) === key(row));
    if (found) return found.id;
    const id = tables[table].length + 1;
    tables[table].push({ id, ...row });
    return id;
  };
  tables.query = async (sql, params) => {
    if (sql.startsWith('INSERT INTO casos')) return [{ insertId: upsert('casos', { nuc: params[0], ano: params[1] }, (r) => `${r.nuc}|${r.ano}`) }];
    if (sql.startsWith('INSERT INTO delitos')) return [{ insertId: upsert('delitos', { nombre: params[0] }, (r) => fold(r.nombre)) }];
    if (sql.startsWith('SELECT nombre FROM delitos WHERE id')) return [[tables.delitos.find((r) => r.id === params[0])]];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  return tables;
};

test('a case is one NUC within one year', async () => {
  const db = fakeDb();
  const a = await casoIdPara(db, ' 12345 ', '2026');
  assert.equal(await casoIdPara(db, '12345', '2026'), a);
  assert.notEqual(await casoIdPara(db, '12345', '2025'), a);
  assert.equal(db.casos.length, 2);
  assert.equal(await casoIdPara(db, '', '2026'), null);
  assert.equal(await casoIdPara(db, '12345', ''), null);
});

test('a delito wording joins the catalog once, with the catalog spelling', async () => {
  const db = fakeDb();
  const first = await delitoPara(db, 'Robo  de   vehículo ');
  assert.deepEqual(first, { id: 1, nombre: 'Robo de vehículo' });
  assert.deepEqual(await delitoPara(db, 'ROBO DE VEHICULO'), first);
  assert.deepEqual(await delitoPara(db, 'Homicidio'), { id: 2, nombre: 'Homicidio' });
  assert.deepEqual(await delitoPara(db, '   '), { id: null, nombre: null });
  assert.equal(db.delitos.length, 2);
});

test('delito text is trimmed, single-spaced and capped at 255 characters', () => {
  assert.equal(normalizarDelito(' a \n b\tc '), 'a b c');
  assert.equal(normalizarDelito('x'.repeat(300)).length, 255);
  assert.equal(normalizarDelito(null), '');
});
