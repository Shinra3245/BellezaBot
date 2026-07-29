// Envío de mensajes por la WhatsApp Cloud API (Graph API de Meta).
// WHATSAPP_MODE=mock evita llamadas reales en desarrollo (registra el envío en memoria/log).
const env = require('../config/env');
const logger = require('../utils/logger');

const GRAPH_VERSION = 'v21.0';

// Buffer de envíos en modo mock; útil para inspección en pruebas.
const sentInMock = [];

/**
 * Normaliza el número destino al formato que acepta la Graph API.
 * México: los webhooks entrantes traen el wa_id como 521XXXXXXXXXX (con un "1" extra tras el 52),
 * pero para ENVIAR hay que usar 52XXXXXXXXXX (sin el "1"). Ver error (#131030).
 */
function normalizeRecipient(to) {
  const digits = String(to).replace(/\D/g, '');
  if (/^521\d{10}$/.test(digits)) return '52' + digits.slice(3);
  return digits;
}

/**
 * Envía un mensaje de texto a un número por WhatsApp.
 * @param {string} phoneNumberId phone_number_id del negocio (emisor) en Meta
 * @param {string} to teléfono destino en E.164 (sin '+', como lo maneja Meta)
 * @param {string} text cuerpo del mensaje
 * @returns {Promise<{ mode: string, ok: boolean }>}
 */
async function sendTextMessage(phoneNumberId, to, text) {
  const recipient = normalizeRecipient(to);

  if (env.WHATSAPP_MODE === 'mock') {
    // MOCK: reemplazar activando WHATSAPP_MODE=real cuando existan META_ACCESS_TOKEN y el phone_number_id (Fase 1.4)
    sentInMock.push({ phoneNumberId, to: recipient, text });
    logger.info('[whatsapp:mock] Mensaje simulado', { to: recipient, text });
    return { mode: 'mock', ok: true };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: text },
  };

  // Reintentos ante fallos de red transitorios (no ante rechazos de Meta, que son definitivos).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Rechazo de Meta (4xx/5xx con respuesta): definitivo, no reintentar.
        const detail = await res.text().catch(() => '');
        logger.error('[whatsapp] Meta rechazó el envío', { status: res.status, to: recipient, detail });
        return { mode: 'real', ok: false };
      }
      if (attempt > 1) logger.info('[whatsapp] Envío exitoso tras reintento', { to: recipient, attempt });
      return { mode: 'real', ok: true };
    } catch (err) {
      // Error de red (fetch failed, timeout): reintentar con backoff.
      if (attempt === MAX_ATTEMPTS) {
        logger.error('[whatsapp] Error de red al enviar a Meta (agotados los reintentos)', {
          to: recipient, error: err.message, attempts: attempt,
        });
        return { mode: 'real', ok: false };
      }
      logger.warn('[whatsapp] Error de red al enviar; reintentando', { to: recipient, error: err.message, attempt });
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  return { mode: 'real', ok: false };
}

module.exports = { sendTextMessage, sentInMock, normalizeRecipient };
