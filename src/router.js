import express from "express";
import { createGeoreferenciacionRouter } from './georeferenciacionRouter.js';
import { forwardAsyncErrors } from './errorHandling.js';
import lineasRoutes from './lineasRoutes.js';
import imeiRoutes from './imeiRoutes.js';
import ubicacionesRoutes from './ubicacionesRoutes.js';
import metricasRoutes from './metricasRoutes.js';
import rutaRoutes from './rutaRoutes.js';
import telefonoRoutes from './telefonoRoutes.js';
import pool from "./db.js";

// Each module declares full paths, so mounting them at the root keeps every URL unchanged.
const router = forwardAsyncErrors(express.Router());

router.use(lineasRoutes);
router.use(imeiRoutes);
router.use(ubicacionesRoutes);
router.use(metricasRoutes);
router.use(rutaRoutes);
router.use(telefonoRoutes);
router.use('/georeferenciacion', createGeoreferenciacionRouter(pool));

router.get("/No", async (req, res) => {
    res.redirect("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1");

});

export default router;
