// Definición y ejecución de las tools de la IA para el flujo de ADMIN (la dueña).
// Aislamiento multi-tenant: el business_id SIEMPRE viene del contexto del servidor (ctx.business),
// NUNCA de parámetros decididos por la IA. La dueña solo ve/toca citas de SU negocio.
const appointmentService = require('../services/appointmentService');
const whatsappService = require('../services/whatsappService');
const logger = require('../utils/logger');

// Plantilla aprobada para avisar a la clienta de una reprogramación (params: nombre, servicio, nueva fecha).
const RESCHEDULE_TEMPLATE = 'cita_reprogramada';

const definitions = [
  {
    name: 'get_appointments',
    description:
      'Devuelve las citas de un día (hoy por defecto) con hora, servicio, nombre y teléfono de la clienta, y estado. Úsala cuando la dueña pregunte por su agenda.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD (zona del negocio). Si se omite, hoy.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_appointment_admin',
    description:
      'Cancela una cita futura del negocio identificada por su ID y avisa automáticamente a la clienta afectada. Confirma con la dueña antes de llamar a esta tool.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'ID de la cita a cancelar (de get_appointments)' },
      },
      required: ['appointment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_appointment_admin',
    description:
      'Reprograma una cita futura a un nuevo horario. Revalida disponibilidad y avisa a la clienta. Úsala tras confirmar el nuevo horario con la dueña.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'ID de la cita a reprogramar' },
        new_datetime: { type: 'string', description: 'Nuevo inicio en ISO 8601 (zona del negocio)' },
      },
      required: ['appointment_id', 'new_datetime'],
      additionalProperties: false,
    },
  },
  {
    name: 'block_time_slot',
    description:
      'Bloquea un rango de horario (descanso, cita personal, etc.) para que deje de ofrecerse a las clientas.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Fecha del bloqueo en YYYY-MM-DD' },
        start_time: { type: 'string', description: 'Hora de inicio HH:MM (24h)' },
        end_time: { type: 'string', description: 'Hora de fin HH:MM (24h)' },
        reason: { type: 'string', description: 'Motivo del bloqueo (opcional)' },
      },
      required: ['date', 'start_time', 'end_time'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_week_summary',
    description: 'Resumen de la semana en curso: total de citas y desglose por día y por estado.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// Ejecuta una tool admin. ctx = { business }. Devuelve un string para el tool_result.
async function execute(name, input, ctx) {
  const businessId = ctx.business.id;
  const timezone = ctx.business.timezone;
  const phoneNumberId = ctx.business.wa_phone_number_id;

  switch (name) {
    case 'get_appointments': {
      const date = input.date || isoDateInZone(timezone);
      const res = await appointmentService.getAppointmentsByDate({ businessId, date, timezone });
      if (res.error) return JSON.stringify({ error: res.error });
      return JSON.stringify({
        fecha: date,
        citas: res.appointments.map((a) => ({
          cita_id: a.id,
          hora: a.when,
          servicio: a.service_name,
          cliente: a.client_name || '(sin nombre)',
          telefono: a.client_phone,
          estado: a.status,
        })),
      });
    }

    case 'cancel_appointment_admin': {
      const res = await appointmentService.cancelAppointmentAdmin({
        businessId,
        appointmentId: input.appointment_id,
      });
      if (res.error) return JSON.stringify({ error: res.error });
      // Avisar a la clienta afectada (texto libre; solo llega dentro de su ventana de 24h).
      // MOCK/limitación: falta plantilla aprobada `cita_cancelada` para avisar fuera de esa ventana.
      const aviso =
        `Hola ${res.clientName || ''}, lamentamos informarte que tu cita de ${res.serviceName} fue cancelada. ` +
        `Escríbenos para reagendar cuando gustes. 🙏`.replace(/\s+/g, ' ').trim();
      let notified = false;
      try {
        const delivery = await whatsappService.sendTextMessage(phoneNumberId, res.clientPhone, aviso);
        notified = Boolean(delivery?.ok);
        if (!notified) throw new Error('envío rechazado por Meta');
      } catch (err) {
        logger.error('[admin] No se pudo avisar de la cancelación', { error: err.message });
      }
      return JSON.stringify({ ok: true, cancelada: res.id, cliente_avisada: notified });
    }

    case 'reschedule_appointment_admin': {
      const res = await appointmentService.rescheduleAppointmentAdmin({
        businessId,
        appointmentId: input.appointment_id,
        newDatetimeIso: input.new_datetime,
        timezone,
      });
      if (res.error) return JSON.stringify({ error: res.error });
      let notified = false;
      try {
        const delivery = await whatsappService.sendTemplateMessage(phoneNumberId, res.clientPhone, RESCHEDULE_TEMPLATE, [
          res.clientName || 'cliente',
          res.serviceName,
          res.whenLabel,
        ]);
        notified = Boolean(delivery?.ok);
        if (!notified) throw new Error('envío rechazado por Meta');
      } catch (err) {
        logger.error('[admin] No se pudo avisar de la reprogramación', { error: err.message });
      }
      return JSON.stringify({ ok: true, cita_id: res.id, nuevo_horario: res.whenLabel, cliente_avisada: notified });
    }

    case 'block_time_slot': {
      const res = await appointmentService.createBlock({
        businessId,
        date: input.date,
        startTime: input.start_time,
        endTime: input.end_time,
        reason: input.reason,
        timezone,
      });
      if (res.error) return JSON.stringify({ error: res.error });
      return JSON.stringify({ ok: true, bloqueo_id: res.id, rango: res.whenLabel });
    }

    case 'get_week_summary': {
      const res = await appointmentService.getWeekSummary({ businessId, timezone });
      return JSON.stringify({ total: res.total, por_dia: res.byDay, por_estado: res.byStatus });
    }

    default:
      return JSON.stringify({ error: 'tool_desconocida' });
  }
}

// Fecha de hoy (YYYY-MM-DD) en la zona del negocio.
function isoDateInZone(timezone) {
  const { DateTime } = require('luxon');
  return DateTime.now().setZone(timezone).toFormat('yyyy-LL-dd');
}

module.exports = { definitions, execute, RESCHEDULE_TEMPLATE };
