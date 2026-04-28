const express = require('express');
const checkSubscription = require('../middlewares/checkSubscription');
const router = express.Router();

// Endpoint para verificar el Webhook de Meta (Meta requiere esto para validar el webhook)
router.get('/', (req, res) => {
    res.send('Webhook endpoint is ready');
});

// Endpoint POST para recibir los mensajes de WhatsApp
router.post('/', checkSubscription, (req, res) => {
    console.log('Mensaje de WhatsApp recibido y suscripción validada:', req.body);
    res.status(200).send('EVENT_RECEIVED');
});

module.exports = router;