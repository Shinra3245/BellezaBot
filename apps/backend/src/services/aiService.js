// Motor de IA: Claude Haiku + function calling. TODO lo específico de Anthropic vive aquí,
// para poder cambiar de proveedor tocando solo este archivo.
const env = require('../config/env');
const time = require('../utils/time');
const logger = require('../utils/logger');
const appointmentService = require('./appointmentService');
const whatsappService = require('./whatsappService');
const botTools = require('../tools/botTools');
const adminTools = require('../tools/adminTools');

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
    `- Si la clienta solicita una hora exacta, conviértela a HH:MM de 24 horas y envíala como preferred_time ` +
    `a check_availability. No concluyas que una hora de la tarde está ocupada basándote solo en una lista general.\n` +
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
  const iterationProfile = getToolIterationProfile(clientPhone);
  const maxToolIterations = iterationProfile.maxIterations;
  logger.info('[ai] Perfil de iteraciones', {
    business_id: business.id,
    max_iterations: maxToolIterations,
    extended: iterationProfile.extended,
    configured_extended_phones: iterationProfile.configuredPhoneCount,
    client_suffix: iterationProfile.clientSuffix,
  });
  let availabilityDateNeedsCorrection = false;
  const requestedExactTime = !isAdmin ? getRequestedExactTime(history) : null;
  const requestedAvailabilityDate = !isAdmin
    ? getExpectedClientAvailabilityDate(history, business.timezone)
    : null;
  const exactAvailabilityRequired = Boolean(
    requestedExactTime && isAvailabilityCheckTurn(history)
  );
  const availabilityDateRequired = Boolean(
    requestedAvailabilityDate && isAvailabilityCheckTurn(history)
  );
  let exactAvailabilityChecked = false;
  let availabilityDateChecked = false;
  const appointmentConfirmationRequired = !isAdmin && isAppointmentConfirmationTurn(history);
  let appointmentCreationAttempted = false;
  let appointmentCreated = false;
  let appointmentCreationError = null;
  let appointmentCreationResult = null;
  const cancellationConfirmationRequired = !isAdmin && isCancellationConfirmationTurn(history);
  let cancellationAttempted = false;
  let cancellationSucceeded = false;
  let cancellationError = null;
  const adminWeekSummaryRequired =
    isAdmin && Boolean(adminWeekReferenceDate);
  let adminAgendaResult = null;
  let adminWeekResult = null;
  let adminDirectReply = null;

  for (let i = 0; i < maxToolIterations; i++) {
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
          logger.info('[ai] Ejecutando herramienta', {
            business_id: business.id,
            tool: block.name,
            iteration: i + 1,
            max_iterations: maxToolIterations,
          });
          // La hora escrita por la clienta tiene prioridad sobre la interpretación de la IA.
          // Así una consulta por "6:00 pm" nunca puede degradarse a una lista general del día.
          const toolInput = block.name === 'check_availability'
            ? {
                ...block.input,
                ...(requestedAvailabilityDate ? { date: requestedAvailabilityDate } : {}),
                ...(requestedExactTime ? { preferred_time: requestedExactTime } : {}),
              }
            : block.input;
          if (block.name === 'check_availability') {
            logger.info('[ai] Consulta de disponibilidad', {
              business_id: business.id,
              date: toolInput?.date,
              requested_date: requestedAvailabilityDate || undefined,
              model_date: block.input?.date,
              requested_time: requestedExactTime || undefined,
              model_preferred_time: block.input?.preferred_time,
              effective_preferred_time: toolInput?.preferred_time,
            });
          }
          // Una confirmación de cancelación nunca autoriza otra escritura. Esta barrera
          // evita que el modelo convierta accidentalmente un "sí, cancélala" en una
          // creación o reprogramación, como ocurrió en producción.
          const mutationBlockedByCancellation =
            cancellationConfirmationRequired &&
            (block.name === 'create_appointment' || block.name === 'reschedule_appointment');
          const cancellationBlockedWithoutConfirmation =
            !isAdmin && block.name === 'cancel_appointment' && !cancellationConfirmationRequired;
          if (mutationBlockedByCancellation || cancellationBlockedWithoutConfirmation) {
            result = JSON.stringify({
              ok: false,
              error: mutationBlockedByCancellation
                ? 'cancelacion_pendiente'
                : 'confirmacion_cancelacion_requerida',
              accion_requerida: mutationBlockedByCancellation
                ? 'cancel_appointment'
                : 'solicitar_confirmacion',
            });
            logger.warn('[ai] Escritura bloqueada por seguridad de cancelación', {
              business_id: business.id,
              blocked_tool: block.name,
              reason: mutationBlockedByCancellation
                ? 'cancelacion_pendiente'
                : 'confirmacion_requerida',
            });
          } else {
            result = await toolset.execute(block.name, toolInput, ctx);
          }
          if (block.name === 'check_availability') {
            let parsedResult;
            try {
              parsedResult = JSON.parse(result);
            } catch {
              parsedResult = null;
            }
            exactAvailabilityChecked = Boolean(
              requestedExactTime && parsedResult?.hora_solicitada === requestedExactTime
            );
            availabilityDateChecked = Boolean(
              requestedAvailabilityDate &&
              parsedResult?.fecha_solicitada === requestedAvailabilityDate
            );
            availabilityDateNeedsCorrection = parsedResult?.nota === 'fecha_pasada';
            if (
              requestedExactTime &&
              parsedResult?.hora_solicitada === requestedExactTime &&
              parsedResult?.nota === 'hora_no_disponible'
            ) {
              logger.info('[ai] Hora exacta rechazada por disponibilidad real', {
                business_id: business.id,
                date: parsedResult.fecha_solicitada,
                requested_time: requestedExactTime,
              });
              return formatExactTimeUnavailable(requestedExactTime);
            }
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
              appointmentCreationResult = parsedResult;
            } else if (!appointmentCreated) {
              appointmentCreationError = parsedResult?.error || 'resultado_invalido';
            }
            logger.info('[ai] Resultado de creación de cita', {
              business_id: business.id,
              ok: parsedResult?.ok === true,
              error: parsedResult?.ok === true ? undefined : appointmentCreationError,
            });
          }
          if (block.name === 'cancel_appointment') {
            cancellationAttempted = true;
            const parsedResult = parseToolResult(result);
            cancellationSucceeded = parsedResult?.ok === true;
            cancellationError = cancellationSucceeded
              ? null
              : parsedResult?.error || 'resultado_invalido';
            logger.info('[ai] Resultado de cancelación de cita', {
              business_id: business.id,
              ok: cancellationSucceeded,
              error: cancellationError || undefined,
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
          if (block.name === 'cancel_appointment') {
            cancellationAttempted = true;
            cancellationSucceeded = false;
            cancellationError = 'error_interno';
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
    // Si todavía falta el servicio, preguntar por él es la respuesta correcta:
    // check_availability necesita service_id y no debe forzarse antes de obtenerlo.
    const safeServiceClarification =
      !isAdmin &&
      ((exactAvailabilityRequired && !exactAvailabilityChecked) ||
        (availabilityDateRequired && !availabilityDateChecked)) &&
      asksForServiceSelection(text) &&
      !claimsAvailability(text) &&
      !claimsAppointmentConfirmed(text);
    if (safeServiceClarification) return text;
    if (exactAvailabilityRequired && !exactAvailabilityChecked) {
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          `Corrección interna obligatoria: la clienta solicitó exactamente las ${requestedExactTime}, ` +
          `pero no ejecutaste check_availability para esa hora en este turno. Ejecuta la tool ahora ` +
          `con preferred_time=${requestedExactTime} antes de pedir el nombre o afirmar que está disponible.`,
      });
      continue;
    }
    if (availabilityDateRequired && !availabilityDateChecked) {
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          `Corrección interna obligatoria: la clienta eligió la fecha ${requestedAvailabilityDate}, ` +
          'pero no ejecutaste check_availability para esa fecha en este turno. Consulta esa fecha exacta antes de responder.',
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
    const falseCancellationClaim =
      !isAdmin && claimsAppointmentCancelled(text) && !cancellationSucceeded;
    const missingConfirmedCancellation =
      cancellationConfirmationRequired && !cancellationAttempted;
    if (falseCancellationClaim || missingConfirmedCancellation) {
      messages.push({ role: 'assistant', content: resp.content });
      let correction;
      if (cancellationConfirmationRequired && !cancellationAttempted) {
        correction =
          'Corrección interna obligatoria: la clienta confirmó que desea cancelar, pero todavía no ejecutaste cancel_appointment. ' +
          'Usa get_my_appointments si necesitas identificar la cita y luego ejecuta cancel_appointment. ' +
          'No crees ni reprogrames ninguna cita.';
      } else if (cancellationAttempted && cancellationError) {
        correction =
          `Corrección interna obligatoria: cancel_appointment falló con ${cancellationError}. ` +
          'La cita no fue cancelada. Explica el problema real y no afirmes que se canceló.';
      } else {
        correction =
          'Corrección interna obligatoria: no existe un cancel_appointment exitoso en este turno. ' +
          'No afirmes que la cita fue cancelada.';
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
  if (appointmentCreated && appointmentCreationResult) {
    logger.info('[ai] Creación confirmada al alcanzar el límite de iteraciones', {
      business_id: business.id,
      appointment_id: appointmentCreationResult.cita_id,
      max_iterations: maxToolIterations,
    });
    return formatCreatedAppointment(appointmentCreationResult);
  }
  if (appointmentCreationAttempted && appointmentCreationError) {
    return formatAppointmentCreationError(appointmentCreationError);
  }
  logger.warn('[ai] Límite de iteraciones de tool_use alcanzado', {
    business_id: business.id,
    max_iterations: maxToolIterations,
    extended: iterationProfile.extended,
  });
  return 'Dame un momento, en breve te atiendo 🙏';
}

function normalizeForIntent(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function samePhoneNumber(left, right) {
  const normalizedLeft = whatsappService.normalizeRecipient(left);
  const normalizedRight = whatsappService.normalizeRecipient(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return (
    normalizedLeft.length >= 10 &&
    normalizedRight.length >= 10 &&
    normalizedLeft.slice(-10) === normalizedRight.slice(-10)
  );
}

function getToolIterationProfile(clientPhone) {
  const normalizedClient = whatsappService.normalizeRecipient(clientPhone);
  const extended = env.AI_EXTENDED_TOOL_PHONES.some((phone) => samePhoneNumber(phone, normalizedClient));
  return {
    extended,
    maxIterations: extended
      ? Math.max(env.AI_MAX_TOOL_ITERATIONS, env.AI_EXTENDED_MAX_TOOL_ITERATIONS)
      : env.AI_MAX_TOOL_ITERATIONS,
    configuredPhoneCount: env.AI_EXTENDED_TOOL_PHONES.length,
    clientSuffix: normalizedClient.slice(-4) || 'none',
  };
}

// Extrae únicamente horas explícitas del último mensaje de la clienta y las normaliza
// a HH:MM. Acepta formatos comunes de WhatsApp: 6:00 pm, 6:00 p. m. y 18:00.
function getRequestedExactTime(history) {
  const latestUser = [...history].reverse().find((message) => message.role === 'user');
  if (!latestUser) return null;
  const text = normalizeForIntent(latestUser.content);

  const twelveHour = text.match(
    /\b(\d{1,2})(?:\s*[:;]\s*([0-5]\d))?\s*([ap])\.?\s*m\.?\b/
  );
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    if (hour < 1 || hour > 12) return null;
    const minute = Number(twelveHour[2] || '00');
    if (twelveHour[3] === 'a') hour = hour === 12 ? 0 : hour;
    if (twelveHour[3] === 'p') hour = hour === 12 ? 12 : hour + 12;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const twentyFourHour = text.match(/\b(?:a\s+las?\s+)?([01]?\d|2[0-3])\s*[:;]\s*([0-5]\d)\b/);
  if (!twentyFourHour) return null;
  return `${String(Number(twentyFourHour[1])).padStart(2, '0')}:${twentyFourHour[2]}`;
}

function isAvailabilityCheckTurn(history) {
  const latestUser = [...history].reverse().find((message) => message.role === 'user');
  if (!latestUser) return false;
  const text = normalizeForIntent(latestUser.content);
  return (
    /\b(agend\w*|reserv\w*|cita\w*|disponib\w*|horario\w*|hora\w*|dia)\b/.test(text) ||
    /\ba\s+las?\s+\d{1,2}\b/.test(text)
  );
}

function asksForServiceSelection(text) {
  const normalized = normalizeForIntent(text);
  return (
    /\b(cual|que)\b[\s\S]{0,50}\bservicio\b/.test(normalized) ||
    /\bservicio\b[\s\S]{0,50}\b(prefieres|deseas|quieres|eliges|necesitas)\b/.test(normalized)
  );
}

function claimsAvailability(text) {
  const normalized = normalizeForIntent(text);
  return (
    /\b(hay|tenemos|existe) disponibilidad\b/.test(normalized) ||
    /\b(horarios?|hora) disponibles?\b/.test(normalized) ||
    /\b(esta|sigue) disponible\b/.test(normalized)
  );
}

function formatExactTimeUnavailable(requestedTime) {
  const [hour, minute] = requestedTime.split(':').map(Number);
  const period = hour < 12 ? 'a. m.' : 'p. m.';
  const displayHour = hour % 12 || 12;
  return (
    `Ese horario (${displayHour}:${String(minute).padStart(2, '0')} ${period}) no está disponible ` +
    'para ese servicio. ¿Quieres que te muestre otros horarios de ese día? 😊'
  );
}

// Reconoce el turno específico en que la clienta acepta la propuesta que el bot acaba de resumir.
function isAppointmentConfirmationTurn(history) {
  const latestUserIndex = history.map((message) => message.role).lastIndexOf('user');
  if (latestUserIndex < 0) return false;

  const latestUser = normalizeForIntent(history[latestUserIndex].content);
  if (!isAffirmativeReply(latestUser)) return false;

  for (let i = latestUserIndex - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    const previousAssistant = normalizeForIntent(history[i].content);
    const isAnotherAction = /\b(cancel\w*|reprogram\w*)\b/.test(previousAssistant);
    return (
      !isAnotherAction &&
      /\bcita\b/.test(previousAssistant) &&
      /\bconfirm(?:o|ar|as|acion)\b/.test(previousAssistant)
    );
  }
  return false;
}

function isAffirmativeReply(normalizedText) {
  return (
    /\bconfirmo\b/.test(normalizedText) ||
    /^(si|correcto|adelante|de acuerdo|ok|okay|vale)(\b|[,.!])/u.test(normalizedText)
  );
}

// Reconoce el "sí" que responde directamente a una confirmación de cancelación.
// Se mantiene separado de isAppointmentConfirmationTurn para que nunca active
// accidentalmente create_appointment.
function isCancellationConfirmationTurn(history) {
  const latestUserIndex = history.map((message) => message.role).lastIndexOf('user');
  if (latestUserIndex < 0) return false;

  const latestUser = normalizeForIntent(history[latestUserIndex].content);
  if (!isAffirmativeReply(latestUser)) return false;

  for (let i = latestUserIndex - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    const previousAssistant = normalizeForIntent(history[i].content);
    return (
      /\b(cita|reservacion|turno)\b/.test(previousAssistant) &&
      /\bcancel\w*\b/.test(previousAssistant) &&
      /\bconfirm\w*\b/.test(previousAssistant)
    );
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

function claimsAppointmentCancelled(text) {
  const normalized = normalizeForIntent(text);
  return (
    /\b(cita|reservacion|turno)\b[\s\S]{0,100}\bcancelad[ao]\b/.test(normalized) ||
    /\bcancelad[ao]\b[\s\S]{0,100}\b(cita|reservacion|turno)\b/.test(normalized)
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

function parseClientDate(value, timezone) {
  const text = normalizeForIntent(value);
  const now = time.nowInZone(timezone).startOf('day');
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const parsed = time.startOfDay(isoMatch[1], timezone);
    return parsed.isValid ? parsed : null;
  }

  const namedDate = text.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)\s+(\d{4}))?\b/
  );
  if (!namedDate) return null;

  const explicitYear = namedDate[3] ? Number(namedDate[3]) : null;
  let parsed = time.DateTime.fromObject(
    {
      year: explicitYear || now.year,
      month: SPANISH_MONTHS[namedDate[2]],
      day: Number(namedDate[1]),
    },
    { zone: timezone }
  ).startOf('day');
  if (!parsed.isValid) return null;
  if (!explicitYear && parsed < now) parsed = parsed.plus({ years: 1 });
  return parsed;
}

function nextDateWithDayOfMonth(day, timezone) {
  const now = time.nowInZone(timezone).startOf('day');
  for (let monthOffset = 0; monthOffset <= 12; monthOffset++) {
    const month = now.plus({ months: monthOffset }).startOf('month');
    const candidate = month.set({ day });
    if (candidate.isValid && candidate >= now) return candidate;
  }
  return null;
}

// Conserva la fecha elegida por la clienta aunque responda de forma corta, por
// ejemplo «Sí, el día 10», tomando el mes del mensaje inmediatamente anterior.
function getExpectedClientAvailabilityDate(history, timezone) {
  const latestUserIndex = history.map((message) => message.role).lastIndexOf('user');
  if (latestUserIndex < 0) return null;

  const latestText = normalizeForIntent(history[latestUserIndex].content);
  const directDate = parseClientDate(latestText, timezone);
  if (directDate) return directDate.toFormat('yyyy-LL-dd');

  const dayReference = latestText.match(/\bdia\s+(\d{1,2})\b/);
  const referencedDay = dayReference ? Number(dayReference[1]) : null;
  const isContinuation = Boolean(
    referencedDay ||
    isAffirmativeReply(latestText) ||
    /\ba\s+las?\s+\d{1,2}\b/.test(latestText)
  );
  if (!isContinuation) return null;

  for (let i = latestUserIndex - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    const previousDate = parseClientDate(history[i].content, timezone);
    if (previousDate && (!referencedDay || previousDate.day === referencedDay)) {
      return previousDate.toFormat('yyyy-LL-dd');
    }
    break;
  }

  const inferred = referencedDay ? nextDateWithDayOfMonth(referencedDay, timezone) : null;
  return inferred ? inferred.toFormat('yyyy-LL-dd') : null;
}

function formatCreatedAppointment(result) {
  const lines = [
    '🎉 *Tu cita está confirmada*',
    '',
    `💅 *Servicio:* ${result.servicio}`,
    `📅 *Fecha y hora:* ${result.cuando}`,
  ];
  if (result.precio !== undefined) lines.push(`💰 *Precio:* $${result.precio}`);
  lines.push('', '¡Te esperamos! 😊');
  return lines.join('\n');
}

function formatAppointmentCreationError(error) {
  const messages = {
    slot_ocupado: 'Ese horario ya no está disponible porque se cruza con otra cita. ¿Quieres elegir otro? 😊',
    fuera_de_horario: 'Ese horario queda fuera del horario de atención. ¿Quieres que busquemos otro? 😊',
    slot_bloqueado: 'Ese horario está bloqueado. ¿Quieres que busquemos otro? 😊',
    muy_pronto: 'Ese horario está demasiado próximo para reservarlo. ¿Quieres elegir uno posterior? 😊',
    fecha_fuera_de_ventana: 'Esa fecha queda fuera del periodo permitido para reservar. ¿Elegimos otra? 😊',
    servicio_no_encontrado: 'No pude identificar el servicio seleccionado. ¿Me indicas nuevamente cuál deseas? 😊',
    fecha_invalida: 'No pude interpretar correctamente la fecha y la hora. ¿Me las indicas nuevamente? 😊',
  };
  return messages[error] || 'No pude completar la reservación. Verifiquemos nuevamente los datos. 🙏';
}

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
