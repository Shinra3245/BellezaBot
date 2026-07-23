const express = require('express');
const env = require('../config/env');
const logger = require('../utils/logger');
const { isValidSignature } = require('../utils/metaSignature');
const businessService = require('../services/businessService');
const conversationService = require('../services/conversationService');
const { processInboundMessage } = require('../services/messageHandler');

const router = express.Router();

// --- 1.1 Verificación del webhook (GET) ---
// Meta hace un GET con hub.mode/hub.verify_token/hub.challenge al registrar la URL.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
    logger.info('[webhook] Verificación de Meta exitosa');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- 1.2 Recepción de mensajes (POST) ---
// Regla de oro: nunca responder 4xx/5xx a Meta salvo firma inválida (Meta reintenta y
// puede desactivar el webhook). Ante cualquier error interno → 200 y log.
router.post('/', async (req, res) => {
  // Validación de firma X-Hub-Signature-256 sobre el body CRUDO.
  const signature = req.get('x-hub-signature-256');
  if (env.META_APP_SECRET) {
    if (!isValidSignature(req.rawBody, signature, env.META_APP_SECRET)) {
      logger.warn('[webhook] Firma inválida: rechazado');
      return res.sendStatus(401);
    }
  } else if (env.NODE_ENV === 'production') {
    // En producción la firma es obligatoria; sin secreto no podemos confiar en el evento.
    logger.error('[webhook] META_APP_SECRET no configurado en producción: rechazado');
    return res.sendStatus(401);
  } else {
    // MOCK: en desarrollo sin META_APP_SECRET no se valida la firma. Configurar en Fase 1.4.
    logger.warn('[webhook] Firma no verificada (META_APP_SECRET ausente, entorno de desarrollo)');
  }

  try {
    const parsed = parseIncomingTextMessage(req.body);
    if (!parsed) {
      // Eventos de estado (statuses), tipos no-texto o payloads sin mensaje: se ignoran.
      return res.sendStatus(200);
    }

    const { phoneNumberId, from, waMessageId, text } = parsed;

    const business = await businessService.getByPhoneNumberId(phoneNumberId);
    if (!business) {
      logger.warn('[webhook] Mensaje para un phone_number_id desconocido', { phoneNumberId });
      return res.sendStatus(200);
    }

    const conversationId = await conversationService.getOrCreate(business.id, from);

    // Idempotencia: si el mensaje ya existía (reintento de Meta), no reprocesar.
    const { duplicate } = await conversationService.saveInboundMessage({
      conversationId,
      waMessageId,
      content: text,
    });
    if (duplicate) {
      logger.info('[webhook] Reintento de Meta ignorado (mensaje duplicado)', { waMessageId });
      return res.sendStatus(200);
    }

    // Responder 200 a Meta INMEDIATAMENTE y procesar de forma asíncrona.
    res.sendStatus(200);

    processInboundMessage({ business, from, text, conversationId }).catch((err) => {
      logger.error('[webhook] Error procesando mensaje de forma asíncrona', {
        business_id: business.id,
        error: err.message,
      });
    });
  } catch (err) {
    // Nunca propagar 5xx a Meta: loggear y responder 200 si aún no se respondió.
    logger.error('[webhook] Error inesperado procesando el webhook', { error: err.message });
    if (!res.headersSent) res.sendStatus(200);
  }
});

/**
 * Extrae un mensaje de texto procesable del payload de Meta.
 * @returns {{ phoneNumberId, from, waMessageId, text }|null} null si no hay texto procesable.
 */
function parseIncomingTextMessage(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return null;

  const message = value.messages?.[0];
  if (!message || message.type !== 'text') return null; // ignora statuses y no-texto

  const phoneNumberId = value.metadata?.phone_number_id;
  const from = message.from;
  const waMessageId = message.id;
  const text = message.text?.body;
  if (!phoneNumberId || !from || !waMessageId || typeof text !== 'string') return null;

  return { phoneNumberId, from, waMessageId, text };
}

module.exports = router;
