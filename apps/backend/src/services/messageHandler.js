// Pipeline de procesamiento de un mensaje entrante ya validado y persistido.
// Fase 1: responde un texto fijo. Fase 2 reemplaza la generación por aiService.generateReply.
const logger = require('../utils/logger');
const conversationService = require('./conversationService');
const whatsappService = require('./whatsappService');
const { isSubscriptionActive, SERVICE_UNAVAILABLE_MESSAGE } = require('./subscriptionService');

// Respuesta fija de la Fase 1 (se sustituye por la IA en la Fase 2).
const FIXED_REPLY = '¡Hola! Gracias por tu mensaje 🙌 En breve te atiendo.';

/**
 * Procesa un mensaje entrante: valida suscripción, genera respuesta, la guarda y la envía.
 * @param {{ business: object, from: string, text: string, conversationId: string }} ctx
 */
async function processInboundMessage({ business, from, text, conversationId }) {
  // Suscripción vencida/inactiva: mensaje fijo, sin generar respuesta de IA.
  if (!isSubscriptionActive(business)) {
    await sendAndStore({ business, from, conversationId, reply: SERVICE_UNAVAILABLE_MESSAGE });
    logger.warn('Mensaje recibido con suscripción inactiva', {
      business_id: business.id,
      from,
    });
    return;
  }

  // MOCK: en Fase 2 esto será aiService.generateReply({ business, history, tools }).
  const reply = FIXED_REPLY;
  await sendAndStore({ business, from, conversationId, reply });
}

async function sendAndStore({ business, from, conversationId, reply }) {
  await conversationService.saveOutboundMessage({ conversationId, content: reply });
  await whatsappService.sendTextMessage(business.wa_phone_number_id, from, reply);
}

module.exports = { processInboundMessage, FIXED_REPLY };
