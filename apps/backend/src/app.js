const express = require('express');
const db = require('./config/db');
const webhookRoutes = require('./api/webhook');
const authRoutes = require('./api/auth');
const panelRoutes = require('./api/panel');
const adminRoutes = require('./api/admin');
const { corsMiddleware } = require('./middlewares/cors');
const { asyncHandler, errorHandler } = require('./middlewares/errorHandler');

// Construye la app de Express sin ponerla a escuchar (facilita pruebas con supertest).
function createApp() {
  const app = express();

  // CORS para el panel web (frontend en otro origen). El webhook de Meta no lo necesita.
  app.use(corsMiddleware);

  // Captura del raw body para poder validar la firma de Meta en Fase 1 (X-Hub-Signature-256).
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // Healthcheck: verifica que la BD responde.
  app.get(
    '/health',
    asyncHandler(async (req, res) => {
      await db.query('SELECT 1');
      res.json({ ok: true });
    })
  );

  app.use('/webhook', webhookRoutes);
  app.use('/auth', authRoutes);
  app.use('/panel', panelRoutes);
  app.use('/admin', adminRoutes);

  app.get('/', (req, res) => {
    res.send('¡El backend de BellezaBot está vivo!');
  });

  // errorHandler SIEMPRE al final, después de todas las rutas.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
