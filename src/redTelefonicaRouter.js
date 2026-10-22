import express from 'express';
import { fetchFocusNetwork, fetchGeneralNetwork } from './redTelefonicaService.js';

export function createRedTelefonicaRouter(pool) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (req, res) => res.render('pages/red-telefonica', { initialNumber: String(req.query.numero || '') }));
  router.get('/datos', async (req, res, next) => {
    try {
      const numero = String(req.query.numero || '').trim();
      return res.json(numero
        ? await fetchFocusNetwork(pool, numero)
        : await fetchGeneralNetwork(pool, { includeSingles: req.query.todos === '1' }));
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      return next(error);
    }
  });
  return router;
}
