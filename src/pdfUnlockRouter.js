import express from 'express';
import multer from 'multer';
import { unlockPdf, unlockedName } from './pdfUnlockService.js';

const MAX_PDF_BYTES = 50 * 1024 * 1024;

// The PDF is processed in memory and a temporary folder that is deleted right away; nothing is stored.
export function createPdfUnlockRouter({ unlock = unlockPdf } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 2 } }).single('pdf');
  const redirect = (res, message, type = 'error') => res.redirect('/desbloqueo-pdf?' + new URLSearchParams({ message, type }));

  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  router.get('/', (req, res) => res.render('pages/desbloqueo-pdf', {
    maxMegabytes: MAX_PDF_BYTES / 1024 / 1024,
    message: typeof req.query.message === 'string' ? req.query.message : '',
    messageType: req.query.type,
  }));

  router.post('/desbloquear', (req, res, next) => upload(req, res, (error) => (error
    ? redirect(res, error.code === 'LIMIT_FILE_SIZE' ? `El PDF supera el límite de ${MAX_PDF_BYTES / 1024 / 1024} MB.` : 'No fue posible recibir el PDF.')
    : next())), async (req, res) => {
    if (!req.file) return redirect(res, 'Selecciona un PDF.');
    try {
      const { buffer } = await unlock(req.file.buffer, { password: typeof req.body.contrasena === 'string' ? req.body.contrasena : '' });
      res.attachment(unlockedName(req.file.originalname));
      res.type('application/pdf');
      return res.send(buffer);
    } catch (error) {
      return redirect(res, error.message || 'No fue posible desbloquear el PDF.');
    }
  });

  return router;
}
