import express from 'express';
import { forwardAsyncErrors } from './errorHandling.js';
import { createPerfilesStore } from './perfilesService.js';
import { casoPorNucAno, casosDelNuc, fichaCaso, fichaLinea, interpretarBusqueda } from './fichaService.js';
import { lineKey } from '../public/js/planeacion-contactos.js';

// /ficha: a search box for a phone line or a NUC, the line's file and the case's file. Read only.
export function createFichaRouter(pool) {
  const router = forwardAsyncErrors(express.Router());
  const perfiles = createPerfilesStore(pool);
  const verOficios = (req) => req.session.role !== 'uecs';

  router.get('/', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const busqueda = interpretarBusqueda(q);
    if (busqueda.tipo === 'linea') return res.redirect(`/ficha/linea/${busqueda.numero}`);
    let casos = [];
    if (busqueda.tipo === 'nuc') {
      casos = await casosDelNuc(pool, busqueda.nuc);
      if (casos.length === 1 && !busqueda.numero) return res.redirect(`/ficha/caso/${casos[0].id}`);
    }
    return res.render('pages/ficha-buscar', { q, busqueda, casos });
  });

  // From tables that know the NUC and year but not the case id.
  router.get('/caso', async (req, res) => {
    const ano = Number(req.query.ano);
    const id = Number.isInteger(ano) ? await casoPorNucAno(pool, req.query.nuc, ano) : null;
    if (id) return res.redirect(`/ficha/caso/${id}`);
    return res.redirect(`/ficha?${new URLSearchParams({ q: String(req.query.nuc ?? '') })}`);
  });

  router.get('/caso/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).send('Caso inválido.');
    const caso = await fichaCaso(pool, req.session, id);
    if (!caso) return res.status(404).render('pages/ficha-buscar', { q: '', busqueda: { tipo: 'vacia' }, casos: [], aviso: 'Ese caso no existe.' });
    res.set('Cache-Control', 'no-store');
    return res.render('pages/ficha-caso', { caso, verOficios: verOficios(req) });
  });

  router.get('/linea/:numero', async (req, res) => {
    const numero = lineKey(req.params.numero);
    if (!numero || numero !== req.params.numero) {
      return numero ? res.redirect(`/ficha/linea/${numero}`) : res.status(400).send('Número de línea inválido.');
    }
    const ficha = await fichaLinea(pool, req.session, numero, { perfiles });
    res.set('Cache-Control', 'no-store');
    return res.render('pages/ficha-linea', { ficha, verOficios: verOficios(req) });
  });

  return router;
}
