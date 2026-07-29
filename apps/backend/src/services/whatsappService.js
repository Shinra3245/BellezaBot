// Envío de mensajes por la WhatsApp Cloud API (Graph API de Meta).
// WHATSAPP_MODE=mock evita llamadas reales en desarrollo (registra el envío en memoria/log).
const env = require('../config/env');
const logger = require('../utils/logger');

const GRAPH_VERSION = 'v21.0';
const DEFAULT_TEMPLATE_LANG = 'es_MX';

// Buffers de envíos en modo mock; útiles para inspección en pruebas.
const sentInMock = [];
const sentTemplatesInMock = [];

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
 * POST al endpoint de mensajes de Meta con reintentos ante fallos de red transitorios.
 * Los rechazos de Meta (4xx/5xx con respuesta) son definitivos y no se reintentan.
 */
async function postToGraph(phoneNumberId, body, logMeta) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
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
        const detail = await res.text().catch(() => '');
        logger.error('[whatsapp] Meta rechazó el envío', { ...logMeta, status: res.status, detail });
        return { mode: 'real', ok: false };
      }
      if (attempt > 1) logger.info('[whatsapp] Envío exitoso tras reintento', { ...logMeta, attempt });
      return { mode: 'real', ok: true };
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        logger.error('[whatsapp] Error de red al enviar a Meta (agotados los reintentos)', {
          ...logMeta, error: err.message, attempts: attempt,
        });
        return { mode: 'real', ok: false };
      }
      logger.warn('[whatsapp] Error de red al enviar; reintentando', { ...logMeta, error: err.message, attempt });
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  return { mode: 'real', ok: false };
}

/**
 * Envía un mensaje de texto libre (solo dentro de la ventana de 24h del cliente).
 */
async function sendTextMessage(phoneNumberId, to, text) {
  const recipient = normalizeRecipient(to);

  if (env.WHATSAPP_MODE === 'mock') {
    sentInMock.push({ phoneNumberId, to: recipient, text });
    logger.info('[whatsapp:mock] Mensaje simulado', { to: recipient, text });
    return { mode: 'mock', ok: true };
  }

  return postToGraph(phoneNumberId, {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: text },
  }, { to: recipient });
}

/**
 * Envía una plantilla aprobada (permite iniciar conversación fuera de la ventana de 24h).
 * @param {string} templateName nombre de la plantilla aprobada en Meta
 * @param {string[]} params valores para las variables {{1}}, {{2}}... del cuerpo
 */
async function sendTemplateMessage(phoneNumberId, to, templateName, params = [], languageCode = DEFAULT_TEMPLATE_LANG) {
  const recipient = normalizeRecipient(to);

  if (env.WHATSAPP_MODE === 'mock') {
    sentTemplatesInMock.push({ phoneNumberId, to: recipient, templateName, params });
    logger.info('[whatsapp:mock] Plantilla simulada', { to: recipient, templateName, params });
    return { mode: 'mock', ok: true };
  }

  const body = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };
  if (params.length > 0) {
    body.template.components = [
      { type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) },
    ];
  }

  return postToGraph(phoneNumberId, body, { to: recipient, templateName });
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  normalizeRecipient,
  sentInMock,
  sentTemplatesInMock,
};
