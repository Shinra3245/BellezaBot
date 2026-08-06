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
    `- Solo puedes decir que una cita quedó confirmada, agendada o reservada si create_appointment devolvió ` +
    `ok=true en el turno actual. Si la tool devuelve un error, la cita NO existe: explica el problema real y nunca la confirmes.\n` +
    `- Para cancelar o reprogramar, usa get_my_appointments para identificar la cita y confirma la acción antes de ejecutarla.\n` +
    `- Si la clienta rechaza un recordatorio, ayúdala a elegir un nuevo horario y usa reschedule_appointment; no crees una cita duplicada.\n` +
    `- Usa check_availability para proponer horarios reales; ofrece pocas opciones claras.\n` +
    `- Si la clienta menciona día y mes pero omite el año, usa la próxima ocurrencia futura de esa fecha: ` +
    `el año actual si aún no ha pasado o el siguiente si ya pasó. Nunca selecciones un año anterior.\n` +
    `- Si check_availability devuelve fecha_pasada, corrige la fecha y vuelve a ejecutar la tool antes de responder. ` +
    `Nunca presentes fecha_pasada como si el negocio estuviera cerrado o sin disponibilidad.\n` +
    `- Escribe en español, mensajes cortos y cálidos estilo WhatsApp. Usa algún emoji con moderación.\n` +
    `- Si no entiendes o falta información, pregunta de forma breve.`;

  const now = time.nowInZone(business.timezone);
  const volatile =
    `Fecha actual ISO: ${now.toFormat('yyyy-LL-dd')}. ` +
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
    `- Para responder cualquier consulta de agenda o citas de un día, debes ejecutar get_appointments en el turno actual, ` +
    `aunque esperes que el resultado esté vacío. Nunca afirmes que no hay citas sin consultar la tool.\n` +
    `- Si la dueña indica día y mes sin año, usa el año de la fecha actual. Verifica que la fecha enviada a ` +
    `get_appointments coincida exactamente con la solicitada.\n` +
    `- Al usar get_week_summary, informa exactamente el rango semana_desde/semana_hasta devuelto por la tool; ` +
    `no calcules ni inventes esas fechas.\n` +
    `- Las respuestas se leen en WhatsApp móvil: nunca uses tablas Markdown ni columnas con "|". ` +
    `Usa bloques cortos, una cita debajo de otra y pocos emojis como guías visuales.\n` +
    `- Antes de CUALQUIER acción destructiva o irreversible (cancelar o reprogramar una cita), ` +
    `confirma explícitamente con la dueña citando los datos ("¿Cancelo la cita de María de las 4 PM? Sí/No") ` +
    `y solo ejecuta la tool cuando ella confirme.\n` +
    `- Solo operas sobre las citas de ESTE negocio. Nunca menciones ni supongas datos de otros negocios.\n` +
    `- Al cancelar o reprogramar, la clienta afectada recibe un aviso automático; infórmalo a la dueña.\n` +
    `- Escribe en español, mensajes cortos estilo WhatsApp.`;

  const now = time.nowInZone(business.timezone);
  const volatile =
    `Fecha actual ISO: ${now.toFormat('yyyy-LL-dd')}. ` +
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

  const ctx = { business, clientPhone };
  const adminExpectedAgendaDate = isAdmin ? getExpectedAdminAgendaDate(history, business.timezone) : null;
  const adminWeekReferenceDate =
    isAdmin && !adminExpectedAgendaDate ? getAdminWeekReferenceDate(history, business.timezone) : null;

  // Ruta determinista para lecturas administrativas: evita gastar iteraciones de IA y garantiza
  // que "esta semana" y "siguiente semana" siempre consulten la base antes de responder.
  if (adminExpectedAgendaDate) {
    const rawResult = await adminTools.execute(
      'get_appointments',
      { date: adminExpectedAgendaDate },
      ctx
    );
    const parsedResult = parseToolResult(rawResult);
    if (
      parsedResult?.fecha === adminExpectedAgendaDate &&
      Array.isArray(parsedResult?.citas) &&
      !parsedResult.error
    ) {
      logger.info('[ai] Agenda administrativa resuelta directamente', {
        business_id: business.id,
        date: adminExpectedAgendaDate,
        count: parsedResult.citas.length,
      });
      return formatAdminDailyAgenda(parsedResult, business.timezone);
    }
  }

  if (adminWeekReferenceDate) {
    const rawResult = await adminTools.execute(
      'get_week_summary',
      { date: adminWeekReferenceDate },
      ctx
    );
    const parsedResult = parseToolResult(rawResult);
    if (
      typeof parsedResult?.total === 'number' &&
      parsedResult?.semana_desde &&
      parsedResult?.semana_hasta &&
      parsedResult?.por_dia &&
      parsedResult?.por_estado &&
      !parsedResult.error
    ) {
      logger.info('[ai] Resumen semanal administrativo resuelto directamente', {
        business_id: business.id,
        from: parsedResult.semana_desde,
        to: parsedResult.semana_hasta,
        count: parsedResult.total,
      });
      return formatAdminWeekSummary(parsedResult, business.timezone);
    }
  }

  const anthropic = client || getClient();
  // Bifurcación cliente/dueña: cambian el system prompt y el set de tools; el motor es el mismo.
  const toolset = isAdmin ? adminTools : botTools;
  const system = isAdmin ? await buildAdminSystem(business) : await buildSystem(business);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  let availabilityDateNeedsCorrection = false;
  const appointmentConfirmationRequired = !isAdmin && isAppointmentConfirmationTurn(history);
  let appointmentCreationAttempted = false;
  let appointmentCreated = false;
  let appointmentCreationError = null;
  const adminWeekSummaryRequired =
    isAdmin && Boolean(adminWeekReferenceDate);
  let adminAgendaResult = null;
  let adminWeekResult = null;
  let adminDirectReply = null;

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
          if (block.name === 'check_availability') {
            logger.info('[ai] Consulta de disponibilidad', {
              business_id: business.id,
              date: block.input?.date,
            });
          }
          result = await toolset.execute(block.name, block.input, ctx);
          if (block.name === 'check_availability') {
            let parsedResult;
            try {
              parsedResult = JSON.parse(result);
            } catch {
              parsedResult = null;
            }
            availabilityDateNeedsCorrection = parsedResult?.nota === 'fecha_pasada';
          }
          if (block.name === 'create_appointment') {
            appointmentCreationAttempted = true;
            let parsedResult;
            try {
              parsedResult = JSON.parse(result);
            } catch {
              parsedResult = null;
            }
            if (parsedResult?.ok === true) {
              appointmentCreated = true;
              appointmentCreationError = null;
            } else if (!appointmentCreated) {
              appointmentCreationError = parsedResult?.error || 'resultado_invalido';
            }
            logger.info('[ai] Resultado de creación de cita', {
              business_id: business.id,
              ok: parsedResult?.ok === true,
              error: parsedResult?.ok === true ? undefined : appointmentCreationError,
            });
          }
          if (block.name === 'get_appointments') {
            let parsedResult;
            try {
              parsedResult = JSON.parse(result);
            } catch {
              parsedResult = null;
            }
            logger.info('[ai] Consulta administrativa de agenda', {
              business_id: business.id,
              requested_date: adminExpectedAgendaDate,
              tool_date: parsedResult?.fecha || block.input?.date,
              count: Array.isArray(parsedResult?.citas) ? parsedResult.citas.length : undefined,
              error: parsedResult?.error,
            });
            if (
              (!adminExpectedAgendaDate || parsedResult?.fecha === adminExpectedAgendaDate) &&
              Array.isArray(parsedResult?.citas) &&
              !parsedResult.error
            ) {
              adminAgendaResult = parsedResult;
              adminDirectReply = formatAdminDailyAgenda(parsedResult, business.timezone);
            }
          }
          if (block.name === 'get_week_summary') {
            let parsedResult;
            try {
              parsedResult = JSON.parse(result);
            } catch {
              parsedResult = null;
            }
            if (
              typeof parsedResult?.total === 'number' &&
              parsedResult?.semana_desde &&
              parsedResult?.semana_hasta &&
              parsedResult?.por_dia &&
              parsedResult?.por_estado
            ) {
              adminWeekResult = parsedResult;
              adminDirectReply = formatAdminWeekSummary(parsedResult, business.timezone);
            }
          }
        } catch (err) {
          if (block.name === 'create_appointment') {
            appointmentCreationAttempted = true;
            appointmentCreationError = 'error_interno';
          }
          logger.error('[ai] Error ejecutando tool', { tool: block.name, error: err.message });
          result = JSON.stringify({ error: 'error_interno' });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: toolResults });
      // Las consultas administrativas de solo lectura se presentan desde el backend para
      // garantizar datos y formato móvil; la IA solo interpreta qué tool debe ejecutar.
      if (adminDirectReply) return adminDirectReply;
      continue;
    }

    // Respuesta final de texto.
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (availabilityDateNeedsCorrection) {
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          'Corrección interna obligatoria: la fecha consultada estaba en el pasado. Recalcula la próxima fecha futura correspondiente y ejecuta check_availability otra vez antes de responder a la clienta.',
      });
      continue;
    }
    // Esta barrera pertenece solo al flujo de clientas. En modo admin es normal describir
    // una cita existente con estado "confirmada" y eso nunca debe activar create_appointment.
    const falseConfirmationClaim = !isAdmin && claimsAppointmentConfirmed(text) && !appointmentCreated;
    const missingConfirmedCreation = appointmentConfirmationRequired && !appointmentCreationAttempted;
    if (falseConfirmationClaim || missingConfirmedCreation) {
      messages.push({ role: 'assistant', content: resp.content });
      let correction;
      if (appointmentConfirmationRequired && !appointmentCreationAttempted) {
        correction =
          'Corrección interna obligatoria: la clienta ya confirmó los datos de la cita, pero todavía no ejecutaste create_appointment. Ejecuta esa tool ahora y solo confirma la cita si devuelve ok=true.';
      } else if (appointmentCreationAttempted && appointmentCreationError) {
        correction =
          `Corrección interna obligatoria: create_appointment falló con ${appointmentCreationError}. ` +
          'La cita no fue creada. Explica ese problema a la clienta y no digas que quedó confirmada, agendada o reservada.';
      } else {
        correction =
          'Corrección interna obligatoria: no existe un create_appointment exitoso en este turno. No afirmes que la cita quedó confirmada; solicita la confirmación explícita que falte antes de crearla.';
      }
      messages.push({ role: 'user', content: correction });
      continue;
    }
    const missingAdminAgendaQuery = adminExpectedAgendaDate && !adminAgendaResult;
    const falseEmptyAdminAgenda =
      adminAgendaResult?.citas.length > 0 && claimsNoAppointments(text);
    if (missingAdminAgendaQuery || falseEmptyAdminAgenda) {
      messages.push({ role: 'assistant', content: resp.content });
      const correction = missingAdminAgendaQuery
        ? `Corrección interna obligatoria: la dueña pidió la agenda de ${adminExpectedAgendaDate}. ` +
          `Ejecuta get_appointments exactamente con date=${adminExpectedAgendaDate} antes de responder; no uses otra fecha ni inventes el resultado.`
        : `Corrección interna obligatoria: get_appointments devolvió ${adminAgendaResult.citas.length} cita(s) ` +
          `para ${adminAgendaResult.fecha}. Resume esas citas reales y no digas que la agenda está vacía.`;
      messages.push({ role: 'user', content: correction });
      continue;
    }
    if (adminWeekSummaryRequired && !adminWeekResult) {
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          'Corrección interna obligatoria: la dueña pidió un resumen semanal. Ejecuta get_week_summary antes de responder y no inventes el rango ni los conteos.',
      });
      continue;
    }
    return text || 'Perdona, ¿me lo repites? 🙏';
  }

  // Se agotaron las iteraciones de tools sin respuesta final.
  logger.warn('[ai] Límite de iteraciones de tool_use alcanzado', { business_id: business.id });
  return 'Dame un momento, en breve te atiendo 🙏';
}

function normalizeForIntent(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Reconoce el turno específico en que la clienta acepta la propuesta que el bot acaba de resumir.
function isAppointmentConfirmationTurn(history) {
  const latestUserIndex = history.map((message) => message.role).lastIndexOf('user');
  if (latestUserIndex < 0) return false;

  const latestUser = normalizeForIntent(history[latestUserIndex].content);
  const affirmative =
    /\bconfirmo\b/.test(latestUser) ||
    /^(si|correcto|adelante|de acuerdo|ok|okay|vale)(\b|[,.!])/u.test(latestUser);
  if (!affirmative) return false;

  for (let i = latestUserIndex - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    const previousAssistant = normalizeForIntent(history[i].content);
    return /\bcita\b/.test(previousAssistant) && /\bconfirm(?:o|ar|as|acion)\b/.test(previousAssistant);
  }
  return false;
}

// Segunda barrera: aunque el modelo ignore el flujo, una confirmación falsa nunca sale a WhatsApp.
function claimsAppointmentConfirmed(text) {
  const normalized = normalizeForIntent(text);
  return (
    /\b(cita|reservacion|turno)\b[\s\S]{0,100}\b(confirmad[ao]|agendad[ao]|reservad[ao])\b/.test(normalized) ||
    /\b(confirmad[ao]|agendad[ao]|reservad[ao])\b[\s\S]{0,100}\b(cita|reservacion|turno)\b/.test(normalized)
  );
}

const SPANISH_MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function getExpectedAdminAgendaDate(history, timezone) {
  const latestUser = [...history].reverse().find((message) => message.role === 'user');
  if (!latestUser) return null;
  const text = normalizeForIntent(latestUser.content);
  const agendaLookup =
    /\bagenda\b/.test(text) ||
    /\bresumen\b[\s\S]{0,40}\bcitas?\b/.test(text) ||
    /\bconsulta(?:r)?\b[\s\S]{0,40}\b(dia|fecha)\b/.test(text) ||
    /\b(citas?|turnos?)\b[\s\S]{0,40}\b(dia|fecha|hoy|manana|de|del|para)\b/.test(text);
  if (!agendaLookup) return null;

  const now = time.nowInZone(timezone);
  if (/\bhoy\b/.test(text)) return now.toFormat('yyyy-LL-dd');
  if (/\bmanana\b/.test(text)) return now.plus({ days: 1 }).toFormat('yyyy-LL-dd');

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const parsed = time.startOfDay(isoMatch[1], timezone);
    return parsed.isValid ? parsed.toFormat('yyyy-LL-dd') : null;
  }

  const namedDate = text.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)\s+(\d{4}))?\b/
  );
  if (!namedDate) return null;
  const year = namedDate[3] ? Number(namedDate[3]) : now.year;
  const parsed = time.DateTime.fromObject(
    { year, month: SPANISH_MONTHS[namedDate[2]], day: Number(namedDate[1]) },
    { zone: timezone }
  );
  return parsed.isValid ? parsed.toFormat('yyyy-LL-dd') : null;
}

function claimsNoAppointments(text) {
  const normalized = normalizeForIntent(text);
  return (
    /\bsin citas?\b/.test(normalized) ||
    /\bno (?:hay|tienes|tiene) citas?\b/.test(normalized) ||
    /\bninguna cita\b/.test(normalized) ||
    /\bagenda (?:esta )?vacia\b/.test(normalized)
  );
}

function isAdminWeekSummaryTurn(history) {
  const latestUser = [...history].reverse().find((message) => message.role === 'user');
  if (!latestUser) return false;
  const text = normalizeForIntent(latestUser.content);
  return (
    /\bsemana(?:l)?\b/.test(text) && /\b(agenda|citas?|resumen)\b/.test(text) ||
    /\bresumen\b[\s\S]{0,40}\bcitas?\b/.test(text)
  );
}

function getAdminWeekReferenceDate(history, timezone) {
  if (!isAdminWeekSummaryTurn(history)) return null;
  const latestUser = [...history].reverse().find((message) => message.role === 'user');
  const text = normalizeForIntent(latestUser?.content);
  let reference = time.nowInZone(timezone);
  const nextWeek =
    /\b(siguiente|proxima)\s+semana\b/.test(text) ||
    /\bsemana\s+(siguiente|proxima)\b/.test(text);
  if (nextWeek) reference = reference.plus({ weeks: 1 });
  return reference.startOf('week').toFormat('yyyy-LL-dd');
}

function parseToolResult(result) {
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

const ADMIN_STATUS_LABELS = {
  pending: '⏳ Pendiente',
  confirmed: '✅ Confirmada',
  rescheduled: '🔄 Reprogramada',
  cancelled: '🚫 Cancelada',
  completed: '☑️ Completada',
  no_show: '⚠️ No asistió',
};

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function appointmentCountLabel(count) {
  return `${count} ${count === 1 ? 'cita' : 'citas'}`;
}

function formatAdminDailyAgenda(result, timezone) {
  const date = time.startOfDay(result.fecha, timezone).setLocale('es');
  const dateLabel = capitalize(date.toFormat("cccc d 'de' LLLL 'de' yyyy"));
  const lines = [`📅 *Agenda del ${dateLabel}*`];

  if (result.citas.length === 0) {
    lines.push('', 'No hay citas programadas. 📭');
    return lines.join('\n');
  }

  lines.push(`*${appointmentCountLabel(result.citas.length)}*`);
  result.citas.forEach((appointment, index) => {
    lines.push(
      '',
      `*${index + 1}. ${appointment.hora} — ${appointment.servicio}*`,
      `👤 ${appointment.cliente}`,
      `📱 ${appointment.telefono}`,
      ADMIN_STATUS_LABELS[appointment.estado] || `Estado: ${appointment.estado}`
    );
  });
  return lines.join('\n');
}

function formatAdminWeekSummary(result, timezone) {
  const from = time.startOfDay(result.semana_desde, timezone).setLocale('es');
  const to = time.startOfDay(result.semana_hasta, timezone).setLocale('es');
  const sameMonth = from.month === to.month && from.year === to.year;
  const range = sameMonth
    ? `Del ${from.toFormat('cccc d')} al ${to.toFormat("cccc d 'de' LLLL 'de' yyyy")}`
    : `Del ${from.toFormat("cccc d 'de' LLLL")} al ${to.toFormat("cccc d 'de' LLLL 'de' yyyy")}`;
  const lines = [
    '📅 *Resumen semanal*',
    capitalize(range),
    '',
    `Total: *${appointmentCountLabel(result.total)}*`,
  ];

  if (result.total === 0) {
    lines.push('', 'No hay citas programadas esta semana. 📭');
    return lines.join('\n');
  }

  const days = Object.entries(result.por_dia).filter(([, count]) => count > 0);
  if (days.length > 0) {
    lines.push('', '*Por día*');
    for (const [day, count] of days) lines.push(`• ${capitalize(day)}: ${appointmentCountLabel(count)}`);
  }

  const statuses = Object.entries(result.por_estado).filter(([, count]) => count > 0);
  if (statuses.length > 0) {
    lines.push('', '*Por estado*');
    for (const [status, count] of statuses) {
      const label = (ADMIN_STATUS_LABELS[status] || capitalize(status)).replace(/^\S+\s/, '');
      lines.push(`• ${label}: ${count}`);
    }
  }
  return lines.join('\n');
}

module.exports = { generateReply, MOCK_REPLY };
