import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ejs from 'ejs';
import ubicacionesRoutes from '../src/ubicacionesRoutes.js';

const post = async (session) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = session; next(); });
  app.use(ubicacionesRoutes);
  const server = app.listen(0);
  try {
    // An empty body never reaches the database: whoever passes the role check gets the validation error.
    const response = await fetch(`http://127.0.0.1:${server.address().port}/ubicaciones/5/modificar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return response.status;
  } finally {
    server.close();
  }
};

test('administrators and semi-administrators may modify a location; other roles may not', async () => {
  assert.equal(await post({ userId: 1, isAdmin: true, role: 'admin' }), 400);
  assert.equal(await post({ userId: 2, isAdmin: false, role: 'semiadmin' }), 400);
  assert.equal(await post({ userId: 3, isAdmin: false, role: 'usuario' }), 403);
  assert.equal(await post({ userId: 4, isAdmin: false, role: 'uecs' }), 403);
});

test('the edit window is on the page for those who may edit', async () => {
  const render = (currentUser) => ejs.renderFile('views/pages/ubicaciones.ejs', {
    currentUser, currentPath: '/ubicaciones', searchTerm: '',
    ubicaciones: [{ idUbicacion: 1, latitude: 29.1, longitude: -110.9, ubicacion: 'Antena de prueba', lugar: 'Hermosillo, Sonora' }], message: null, messageType: null,
    currentPage: 1, totalPages: 1, startIndex: 0, pageSize: 20, googleMapsApiKey: '',
  }, { views: ['views'] });
  // The window and the "Modificar" button of each row.
  const hasModal = async (user) => {
    const html = await render(user);
    assert.equal(html.includes('id="editLocationModal"'), html.includes('edit-location-btn" data-id='));
    return html.includes('id="editLocationModal"');
  };
  assert.equal(await hasModal({ isAdmin: false, role: 'semiadmin', canEditRecords: true }), true);
  assert.equal(await hasModal({ isAdmin: false, role: 'usuario', canEditRecords: false }), false);
});
