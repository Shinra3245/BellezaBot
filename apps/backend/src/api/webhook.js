const express = require('express');
const router = express.Router();

// Webhook de Meta / WhatsApp Cloud API.
// NOTA (Fase 0): placeholders. La verificación GET, la validación de firma
// X-Hub-Signature-256, la idempotencia y el pipeline asíncrono se implementan en la Fase 1.

// Verificación del webhook (Meta hace un GET al registrar la URL).
router.get('/', (req, res) => {
  res.send('Webhook endpoint is ready');
});

// Recepción de mensajes. Meta exige responder 200 rápido.
router.post('/', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
});

module.exports = router;
