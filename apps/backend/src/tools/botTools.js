// Definición y ejecución de las tools de la IA para el flujo de CLIENTE.
// Aislamiento multi-tenant: el business_id y el client_phone SIEMPRE vienen del contexto
// del servidor (ctx), NUNCA de parámetros decididos por la IA.
const appointmentService = require('../services/appointmentService');
const time = require('../utils/time');

// Esquemas de tools en el formato de la API de Anthropic.
const definitions = [
  {
    name: 'get_service_info',
    description:
      'Devuelve la lista de servicios activos del negocio con su precio y duración. Úsala cuando la clienta pregunte por servicios, precios o duraciones.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_availability',
    description:
      'Devuelve los horarios disponibles para un servicio en una fecha futura. Úsala antes de proponer horarios; nunca inventes horarios ni uses un año anterior al de la fecha actual.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description:
            'Fecha futura en formato YYYY-MM-DD (zona horaria del negocio). Si la clienta omite el año, usa la próxima ocurrencia futura de esa fecha.',
        },
        service_id: { type: 'string', description: 'ID del servicio (de get_service_info)' },
        preferred_time: {
          type: 'string',
          description:
            'Hora exacta solicitada en HH:MM (24h). Inclúyela siempre que la clienta pida una hora específica, por ejemplo 18:15.',
        },
      },
      required: ['date', 'service_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_appointment',
    description:
      'Crea una cita confirmada. Úsala solo después de confirmar con la clienta el servicio, la fecha, la hora y su nombre.',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'ID del servicio' },
        datetime_iso: { type: 'string', description: 'Inicio de la cita en ISO 8601 (de check_availability)' },
        client_name: { type: 'string', description: 'Nombre de la clienta' },
      },
      required: ['service_id', 'datetime_iso', 'client_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_my_appointments',
    description:
      'Devuelve las próximas citas activas de esta clienta, con su ID, servicio y fecha. Úsala antes de cancelar o reprogramar cuando no conozcas el ID.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela una cita futura de la propia clienta, identificada por su ID.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'ID de la cita a cancelar' },
      },
      required: ['appointment_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      'Reprograma una cita futura de esta clienta a un slot previamente devuelto por check_availability. Úsala solo después de confirmar la nueva fecha y hora.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'ID obtenido con get_my_appointments' },
        new_datetime_iso: { type: 'string', description: 'Nuevo inicio ISO 8601 obtenido con check_availability' },
      },
      required: ['appointment_id', 'new_datetime_iso'],
      additionalProperties: false,
    },
  },
];

// Ejecuta una tool. ctx = { business, clientPhone }. Devuelve un string para el tool_result.
async function execute(name, input, ctx) {
  const businessId = ctx.business.id;
  const timezone = ctx.business.timezone;

  switch (name) {
    case 'get_service_info': {
      const services = await appointmentService.listServices(businessId);
      return JSON.stringify(
        services.map((s) => ({
          service_id: s.id,
          nombre: s.name,
          precio: Number(s.price),
          duracion_min: s.duration_minutes,
        }))
      );
    }

    case 'check_availability': {
      const currentDate = time.nowInZone(timezone).toFormat('yyyy-LL-dd');
      const res = await appointmentService.getAvailability({
        businessId,
        date: input.date,
        serviceId: input.service_id,
        timezone,
        preferredTime: input.preferred_time || null,
      });
      const dateContext = {
        fecha_solicitada: input.date,
        fecha_actual: currentDate,
        ...(input.preferred_time ? { hora_solicitada: input.preferred_time } : {}),
      };
      if (res.error) return JSON.stringify({ ...dateContext, error: res.error });
      if (res.past) {
        return JSON.stringify({
          ...dateContext,
          disponibilidad: [],
          nota: 'fecha_pasada',
          accion_requerida:
            'Corrige el año a la próxima fecha futura correspondiente y vuelve a ejecutar check_availability antes de responder.',
        });
      }
      if (res.tooFar) {
        return JSON.stringify({ ...dateContext, disponibilidad: [], nota: 'fecha_fuera_de_ventana' });
      }
      if (res.closed) {
        return JSON.stringify({ ...dateContext, disponibilidad: [], nota: 'cerrado_ese_dia' });
      }
      if (input.preferred_time && res.slots.length === 0) {
        return JSON.stringify({ ...dateContext, disponibilidad: [], nota: 'hora_no_disponible' });
      }
      return JSON.stringify({
        ...dateContext,
        disponibilidad: res.slots.map((s) => ({ datetime_iso: s.datetime_iso, hora: s.label })),
      });
    }

    case 'create_appointment': {
      const res = await appointmentService.createAppointment({
        businessId,
        clientPhone: ctx.clientPhone,
        serviceId: input.service_id,
        datetimeIso: input.datetime_iso,
        clientName: input.client_name,
        timezone,
      });
      if (res.error) return JSON.stringify({ ok: false, cita_creada: false, error: res.error });
      return JSON.stringify({
        ok: true,
        cita_creada: true,
        cita_id: res.id,
        servicio: res.serviceName,
        cuando: res.whenLabel,
        precio: Number(res.price),
      });
    }

    case 'get_my_appointments': {
      const appointments = await appointmentService.getUpcomingAppointments({
        businessId,
        clientPhone: ctx.clientPhone,
        timezone,
      });
      return JSON.stringify({
        citas: appointments.map((appointment) => ({
          cita_id: appointment.id,
          servicio: appointment.serviceName,
          cuando: appointment.whenLabel,
          estado: appointment.status,
        })),
      });
    }

    case 'cancel_appointment': {
      const res = await appointmentService.cancelAppointment({
        businessId,
        clientPhone: ctx.clientPhone,
        appointmentId: input.appointment_id,
      });
      if (res.error) return JSON.stringify({ error: res.error });
      return JSON.stringify({ ok: true, cancelada: res.id });
    }

    case 'reschedule_appointment': {
      const res = await appointmentService.rescheduleAppointmentClient({
        businessId,
        clientPhone: ctx.clientPhone,
        appointmentId: input.appointment_id,
        newDatetimeIso: input.new_datetime_iso,
        timezone,
      });
      if (res.error) return JSON.stringify({ error: res.error });
      return JSON.stringify({ ok: true, cita_id: res.id, nuevo_horario: res.whenLabel });
    }

    default:
      return JSON.stringify({ error: 'tool_desconocida' });
  }
}

module.exports = { definitions, execute };
