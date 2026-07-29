// Motor de IA: Claude Haiku + function calling. TODO lo específico de Anthropic vive aquí,
// para poder cambiar de proveedor tocando solo este archivo.
const env = require('../config/env');
const time = require('../utils/time');
const logger = require('../utils/logger');
const appointmentService = require('./appointmentService');
const botTools = require('../tools/botTools');

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOKENS = 1024; // respuestas cortas estilo WhatsApp
// Respuesta fija en modo mock (dev/pruebas sin gastar tokens ni depender de la red).
const MOCK_REPLY = '¡Hola! Soy el asistente virtual (modo de prueba). ¿En qué te ayudo?';

let _client;
function getClient() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Construye el system prompt. Se separa en dos bloques para el prompt caching:
// el bloque estable (datos del negocio) se cachea; el volátil (fecha/hora actual) va después.
async function buildSystem(business) {
  const services = await appointmentService.listServices(business.id);
  const serviceLines = services.length
    ? services
        .map((s) => `- ${s.name} (id: ${s.id}) — $${Number(s.price)} — ${s.duration_minutes} min`)
        .join('\n')
    : '(sin servicios configurados)';

  const stable =
    `Eres ${business.bot_name || 'el asistente'}, el asistente virtual de "${business.name}", ` +
    `un negocio de estética. Tu personalidad es ${business.bot_personality || 'amable y profesional'} ` +
    `y tu tono es ${business.tone || 'informal'}.\n\n` +
    `Servicios disponibles:\n${serviceLines}\n\n` +
    `Reglas de comportamiento:\n` +
    `- Solo agendas, consultas o cancelas citas usando las herramientas (tools). Nunca inventes ` +
    `horarios, precios ni disponibilidad: consúltalos siempre con las tools.\n` +
    `- Antes de crear una cita, confirma con la clienta el servicio, la fecha, la hora y su nombre.\n` +
    `- Usa check_availability para proponer horarios reales; ofrece pocas opciones claras.\n` +
    `- Escribe en español, mensajes cortos y cálidos estilo WhatsApp. Usa algún emoji con moderación.\n` +
    `- Si no entiendes o falta información, pregunta de forma breve.`;

  const now = time.nowInZone(business.timezone);
  const volatile =
    `Fecha y hora actual: ${time.formatDateTime(now)} (zona ${business.timezone}). ` +
    `Interpreta expresiones como "mañana" o "el viernes" con base en esta fecha.`;

  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatile },
  ];
}

/**
 * Genera la respuesta del bot dado el negocio, el teléfono del cliente y el historial.
 * @param {{ business, clientPhone, history, client? }} args
 *   history: [{ role: 'user'|'assistant', content: string }] en orden cronológico.
 *   client: cliente de Anthropic inyectable (para pruebas); si se omite se usa el real.
 * @returns {Promise<string>} texto final para enviar por WhatsApp.
 */
async function generateReply({ business, clientPhone, history, client }) {
  if (env.AI_MODE === 'mock' && !client) return MOCK_REPLY;

  const anthropic = client || getClient();
  const system = await buildSystem(business);
  const ctx = { business, clientPhone };
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: botTools.definitions,
      messages,
    });

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = await botTools.execute(block.name, block.input, ctx);
        } catch (err) {
          logger.error('[ai] Error ejecutando tool', { tool: block.name, error: err.message });
          result = JSON.stringify({ error: 'error_interno' });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Respuesta final de texto.
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || 'Perdona, ¿me lo repites? 🙏';
  }

  // Se agotaron las iteraciones de tools sin respuesta final.
  logger.warn('[ai] Límite de iteraciones de tool_use alcanzado', { business_id: business.id });
  return 'Dame un momento, en breve te atiendo 🙏';
}

module.exports = { generateReply, MOCK_REPLY };
