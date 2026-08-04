// Pipeline de procesamiento de un mensaje entrante ya validado y persistido.
// Fase 2: genera la respuesta con la IA (aiService) usando el historial y las tools.
const logger = require('../utils/logger');
const conversationService = require('./conversationService');
const whatsappService = require('./whatsappService');
const aiService = require('./aiService');
const { isSubscriptionActive, SERVICE_UNAVAILABLE_MESSAGE } = require('./subscriptionService');

// Mensaje de cortesía si la IA falla (timeout, error de API).
const AI_FALLBACK_MESSAGE = 'Dame un momento, en breve te atiendo 🙏';

// Rate limiting: máximo de mensajes procesados por hora por cliente (protege costos de IA ante spam).
const MAX_MESSAGES_PER_HOUR = 15;

/**
 * Procesa un mensaje entrante: valida suscripción, genera respuesta con IA, la guarda y la envía.
 * @param {{ business, from, text, conversationId }} ctx
 * @param {{ generateReply? }} [deps] inyección para pruebas (por defecto usa aiService).
 */
async function processInboundMessage({ business, from, conversationId }, deps = {}) {
  const generateReply = deps.generateReply || aiService.generateReply;

  // ¿Es la dueña operando desde su celular? → flujo admin; si no, flujo cliente.
  const isAdmin = isOwner(business, from);

  // Suscripción vencida/inactiva: mensaje fijo, sin llamar a la IA (aplica también a la dueña:
  // es su recordatorio de pago).
  if (!isSubscriptionActive(business)) {
    await sendAndStore({ business, from, conversationId, reply: SERVICE_UNAVAILABLE_MESSAGE });
    logger.warn('Mensaje recibido con suscripción inactiva', { business_id: business.id, from });
    return;
  }

  // Rate limiting: solo para clientas (anti-spam de costos de IA). La dueña queda exenta.
  if (!isAdmin) {
    const recentCount = await conversationService.countRecentInbound(conversationId, 60);
    if (recentCount > MAX_MESSAGES_PER_HOUR) {
      logger.warn('Cliente excedió el rate limit; se omite la IA', {
        business_id: business.id, from, recentCount,
      });
      return;
    }
  }

  let reply;
  try {
    const history = await conversationService.getHistory(conversationId);
    reply = await generateReply({ business, clientPhone: from, history, isAdmin });
  } catch (err) {
    logger.error('Error generando respuesta de IA', { business_id: business.id, error: err.message });
    reply = AI_FALLBACK_MESSAGE;
  }

  await sendAndStore({ business, from, conversationId, reply });
}

async function sendAndStore({ business, from, conversationId, reply }) {
  const delivery = await whatsappService.sendTextMessage(business.wa_phone_number_id, from, reply);
  if (!delivery || delivery.ok === false) {
    throw new Error('WhatsApp no aceptó el mensaje saliente');
  }
  // Solo registrar como enviado después de que Meta lo acepta.
  await conversationService.saveOutboundMessage({ conversationId, content: reply });
}

/**
 * ¿El remitente es la dueña del negocio? Compara normalizando ambos números al mismo formato
 * (los wa_id de México traen un "1" extra que normalizeRecipient elimina).
 */
function isOwner(business, from) {
  if (!business.owner_phone) return false;
  return whatsappService.normalizeRecipient(from) === whatsappService.normalizeRecipient(business.owner_phone);
}

module.exports = { processInboundMessage, AI_FALLBACK_MESSAGE, isOwner };
