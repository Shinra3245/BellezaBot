// Persistencia de conversaciones y mensajes (memoria del bot).
// Fase 1: upsert de conversación + guardado idempotente de mensajes entrantes y salientes.
// Fase 2 añade getHistory() para alimentar a la IA.
const db = require('../config/db');

/**
 * Obtiene (o crea) la conversación de un cliente con un negocio y actualiza last_message_at.
 * @returns {Promise<string>} id de la conversación
 */
async function getOrCreate(businessId, clientPhone, channel = 'whatsapp') {
  const { rows } = await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel, last_message_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, client_phone, channel)
     DO UPDATE SET last_message_at = now()
     RETURNING id`,
    [businessId, clientPhone, channel]
  );
  return rows[0].id;
}

/**
 * Guarda un mensaje entrante de forma idempotente por wa_message_id.
 * @returns {Promise<{ duplicate: boolean }>} duplicate=true si Meta reintentó un mensaje ya guardado
 */
async function saveInboundMessage({ conversationId, waMessageId, content }) {
  const { rows } = await db.query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, role, content)
     VALUES ($1, $2, 'inbound', 'user', $3)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [conversationId, waMessageId, content]
  );
  return { duplicate: rows.length === 0 };
}

/**
 * Devuelve los últimos N mensajes de la conversación en orden cronológico,
 * en formato [{ role, content }] para alimentar a la IA. Limita el historial para controlar tokens.
 */
async function getHistory(conversationId, limit = 20) {
  const { rows } = await db.query(
    `SELECT role, content FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

/**
 * Guarda un mensaje saliente (respuesta del bot).
 */
async function saveOutboundMessage({ conversationId, content, waMessageId = null }) {
  await db.query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, role, content)
     VALUES ($1, $2, 'outbound', 'assistant', $3)`,
    [conversationId, waMessageId, content]
  );
}

/**
 * Cuenta los mensajes entrantes de una conversación en los últimos `minutes` minutos.
 * Usado para rate limiting por cliente (proteger costos de IA ante spam).
 */
async function countRecentInbound(conversationId, minutes = 60) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM messages
     WHERE conversation_id = $1 AND direction = 'inbound'
       AND created_at > now() - ($2 || ' minutes')::interval`,
    [conversationId, String(minutes)]
  );
  return rows[0].n;
}

module.exports = {
  getOrCreate,
  saveInboundMessage,
  saveOutboundMessage,
  getHistory,
  countRecentInbound,
};
