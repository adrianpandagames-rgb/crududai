import express from "express";
import { forwardAsyncErrors } from './errorHandling.js';
import { validatePhoneNumber } from './phoneValidation.js';

const router = forwardAsyncErrors(express.Router());

router.get('/telefono', (req, res) => {
  res.render('pages/telefono');
});

/**
 * @openapi
 * /api/telefono/validar:
 *   post:
 *     summary: Validar un número telefónico
 *     tags: [Telefono]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - number
 *             properties:
 *               number:
 *                 type: string
 *                 example: '+521234567890'
 *     responses:
 *       200:
 *         description: Resultado de validación
 *       400:
 *         description: Número inválido
 *       500:
 *         description: Error del servidor
 */
router.post('/api/telefono/validar', async (req, res) => {
  try {
    const result = await validatePhoneNumber(req.body?.number);
    return res.json({ result });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'No fue posible validar el número.' });
  }
});

export default router;
