// Pipeline de procesamiento de un mensaje entrante ya validado y persistido.
// Fase 2: genera la respuesta con la IA (aiService) usando el historial y las tools.
const logger = require('../utils/logger');
const conversationService = require('./conversationService');
const whatsappService = require('./whatsappService');
const aiService = require('./aiService');
const { isSubscriptionActive, SERVICE_UNAVAILABLE_MESSAGE } = require('./subscriptionService');

// Mensaje de cortesía si la IA falla (timeout, error de API).
const AI_FALLBACK_MESSAGE = 'Dame un momento, en breve te atiendo 🙏';

/**
 * Procesa un mensaje entrante: valida suscripción, genera respuesta con IA, la guarda y la envía.
 * @param {{ business, from, text, conversationId }} ctx
 * @param {{ generateReply? }} [deps] inyección para pruebas (por defecto usa aiService).
 */
async function processInboundMessage({ business, from, conversationId }, deps = {}) {
  const generateReply = deps.generateReply || aiService.generateReply;

  // Suscripción vencida/inactiva: mensaje fijo, sin llamar a la IA.
  if (!isSubscriptionActive(business)) {
    await sendAndStore({ business, from, conversationId, reply: SERVICE_UNAVAILABLE_MESSAGE });
    logger.warn('Mensaje recibido con suscripción inactiva', { business_id: business.id, from });
    return;
  }

  let reply;
  try {
    const history = await conversationService.getHistory(conversationId);
    reply = await generateReply({ business, clientPhone: from, history });
  } catch (err) {
    logger.error('Error generando respuesta de IA', { business_id: business.id, error: err.message });
    reply = AI_FALLBACK_MESSAGE;
  }

  await sendAndStore({ business, from, conversationId, reply });
}

async function sendAndStore({ business, from, conversationId, reply }) {
  await conversationService.saveOutboundMessage({ conversationId, content: reply });
  await whatsappService.sendTextMessage(business.wa_phone_number_id, from, reply);
}

module.exports = { processInboundMessage, AI_FALLBACK_MESSAGE };
