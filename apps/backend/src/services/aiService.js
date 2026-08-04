// Motor de IA: Claude Haiku + function calling. TODO lo específico de Anthropic vive aquí,
// para poder cambiar de proveedor tocando solo este archivo.
const env = require('../config/env');
const time = require('../utils/time');
const logger = require('../utils/logger');
const appointmentService = require('./appointmentService');
const botTools = require('../tools/botTools');
const adminTools = require('../tools/adminTools');

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
    `- Solo agendas, consultas, cancelas o reprogramas citas usando las herramientas (tools). Nunca inventes ` +
    `horarios, precios ni disponibilidad: consúltalos siempre con las tools.\n` +
    `- Antes de crear una cita, confirma con la clienta el servicio, la fecha, la hora y su nombre.\n` +
    `- Para cancelar o reprogramar, usa get_my_appointments para identificar la cita y confirma la acción antes de ejecutarla.\n` +
    `- Si la clienta rechaza un recordatorio, ayúdala a elegir un nuevo horario y usa reschedule_appointment; no crees una cita duplicada.\n` +
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

// System prompt del MODO ADMIN (la dueña opera su propia agenda desde su celular).
async function buildAdminSystem(business) {
  const services = await appointmentService.listServices(business.id);
  const serviceLines = services.length
    ? services
        .map((s) => `- ${s.name} (id: ${s.id}) — $${Number(s.price)} — ${s.duration_minutes} min`)
        .join('\n')
    : '(sin servicios configurados)';

  const stable =
    `Eres el asistente de administración de "${business.name}". Estás hablando con la DUEÑA del negocio, ` +
    `no con una clienta. Tu tono es directo, ejecutivo y breve.\n\n` +
    `Servicios del negocio:\n${serviceLines}\n\n` +
    `Qué puedes hacer para la dueña (siempre con las tools, nunca inventes datos):\n` +
    `- Consultar su agenda de un día (get_appointments) y el resumen de la semana (get_week_summary).\n` +
    `- Cancelar una cita (cancel_appointment_admin) o reprogramarla (reschedule_appointment_admin).\n` +
    `- Bloquear rangos de horario (block_time_slot) para que no se ofrezcan a clientas.\n\n` +
    `Reglas:\n` +
    `- Antes de CUALQUIER acción destructiva o irreversible (cancelar o reprogramar una cita), ` +
    `confirma explícitamente con la dueña citando los datos ("¿Cancelo la cita de María de las 4 PM? Sí/No") ` +
    `y solo ejecuta la tool cuando ella confirme.\n` +
    `- Solo operas sobre las citas de ESTE negocio. Nunca menciones ni supongas datos de otros negocios.\n` +
    `- Al cancelar o reprogramar, la clienta afectada recibe un aviso automático; infórmalo a la dueña.\n` +
    `- Escribe en español, mensajes cortos estilo WhatsApp.`;

  const now = time.nowInZone(business.timezone);
  const volatile =
    `Fecha y hora actual: ${time.formatDateTime(now)} (zona ${business.timezone}). ` +
    `Interpreta "hoy", "mañana", "el viernes" con base en esta fecha.`;

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
async function generateReply({ business, clientPhone, history, client, isAdmin = false }) {
  if (env.AI_MODE === 'mock' && !client) return MOCK_REPLY;

  const anthropic = client || getClient();
  // Bifurcación cliente/dueña: cambian el system prompt y el set de tools; el motor es el mismo.
  const toolset = isAdmin ? adminTools : botTools;
  const system = isAdmin ? await buildAdminSystem(business) : await buildSystem(business);
  const ctx = { business, clientPhone };
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: toolset.definitions,
      messages,
    });

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = await toolset.execute(block.name, block.input, ctx);
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
