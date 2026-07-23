const express = require('express');
const db = require('./config/db');
const webhookRoutes = require('./api/webhook');
const { asyncHandler, errorHandler } = require('./middlewares/errorHandler');

// Construye la app de Express sin ponerla a escuchar (facilita pruebas con supertest).
function createApp() {
  const app = express();

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

  app.get('/', (req, res) => {
    res.send('¡El backend de BellezaBot está vivo!');
  });

  // errorHandler SIEMPRE al final, después de todas las rutas.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
