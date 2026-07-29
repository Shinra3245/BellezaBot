// Lógica de disponibilidad y citas. Es la pieza crítica de correctitud del MVP:
// 0 citas empalmadas. El business_id SIEMPRE viene del contexto del servidor.
const db = require('../config/db');
const time = require('../utils/time');

// Decisiones de las Preguntas Abiertas (sección 9 del plan):
const MIN_LEAD_MINUTES = 60; // no permitir citas con menos de 1h de anticipación
const MAX_DAYS_AHEAD = 30; // hasta 30 días en el futuro
const BUFFER_MINUTES = 0; // sin buffer entre citas por ahora (fácil de activar aquí)
const MAX_SLOTS = 6; // máximo de opciones a ofrecer

const ACTIVE_STATUSES = ['pending', 'confirmed', 'rescheduled'];

// Carga un servicio activo del negocio (aísla por business_id).
async function getService(businessId, serviceId) {
  const { rows } = await db.query(
    `SELECT id, name, price, duration_minutes
     FROM services
     WHERE id = $1 AND business_id = $2 AND is_active = true`,
    [serviceId, businessId]
  );
  return rows[0] || null;
}

// Lista de servicios activos del negocio.
async function listServices(businessId) {
  const { rows } = await db.query(
    `SELECT id, name, price, duration_minutes
     FROM services
     WHERE business_id = $1 AND is_active = true
     ORDER BY created_at`,
    [businessId]
  );
  return rows;
}

// Citas activas que se solapan con una ventana [from, to) para un negocio.
async function getOverlappingAppointments(businessId, fromISO, toISO) {
  const { rows } = await db.query(
    `SELECT starts_at, ends_at
     FROM appointments
     WHERE business_id = $1
       AND status = ANY($2)
       AND starts_at < $4 AND ends_at > $3`,
    [businessId, ACTIVE_STATUSES, fromISO, toISO]
  );
  return rows;
}

/**
 * Calcula los huecos libres para un día y servicio.
 * @returns {Promise<{ slots: Array<{datetime_iso, label}>, closed: boolean, tooFar: boolean }>}
 */
async function getAvailability({ businessId, date, serviceId, timezone }) {
  const service = await getService(businessId, serviceId);
  if (!service) return { error: 'servicio_no_encontrado' };

  const dayStart = time.startOfDay(date, timezone);
  if (!dayStart.isValid) return { error: 'fecha_invalida' };

  const now = time.nowInZone(timezone);
  // No agendar más allá de la ventana máxima.
  if (dayStart.diff(now.startOf('day'), 'days').days > MAX_DAYS_AHEAD) {
    return { slots: [], tooFar: true };
  }

  const dayOfWeek = time.jsDayOfWeek(dayStart);
  const { rows: schedules } = await db.query(
    `SELECT start_time, end_time FROM schedules
     WHERE business_id = $1 AND day_of_week = $2
     ORDER BY start_time`,
    [businessId, dayOfWeek]
  );
  if (schedules.length === 0) return { slots: [], closed: true };

  const dayEnd = dayStart.plus({ days: 1 });
  const busy = await getOverlappingAppointments(
    businessId,
    dayStart.toISO(),
    dayEnd.toISO()
  );
  const busyIntervals = busy.map((a) => ({
    start: time.DateTime.fromJSDate(a.starts_at).toMillis(),
    end: time.DateTime.fromJSDate(a.ends_at).toMillis(),
  }));

  const minStart = now.plus({ minutes: MIN_LEAD_MINUTES });
  const duration = service.duration_minutes;
  const slots = [];

  for (const sched of schedules) {
    let slotStart = time.atTime(dayStart, sched.start_time);
    const windowEnd = time.atTime(dayStart, sched.end_time);

    while (slotStart.plus({ minutes: duration }) <= windowEnd) {
      const slotEnd = slotStart.plus({ minutes: duration });

      const inPast = slotStart < minStart;
      const overlaps = busyIntervals.some(
        (b) => b.start < slotEnd.toMillis() && b.end > slotStart.toMillis()
      );

      if (!inPast && !overlaps) {
        slots.push({ datetime_iso: slotStart.toISO(), label: time.formatTime(slotStart) });
        if (slots.length >= MAX_SLOTS) return { slots };
      }
      slotStart = slotStart.plus({ minutes: duration + BUFFER_MINUTES });
    }
  }

  return { slots };
}

/**
 * Crea una cita revalidando disponibilidad dentro de una transacción con lock por negocio
 * (evita condiciones de carrera → 0 empalmes).
 */
async function createAppointment({ businessId, clientPhone, serviceId, datetimeIso, clientName, timezone }) {
  const service = await getService(businessId, serviceId);
  if (!service) return { error: 'servicio_no_encontrado' };

  const startsAt = time.parseISO(datetimeIso, timezone);
  if (!startsAt.isValid) return { error: 'fecha_invalida' };
  const endsAt = startsAt.plus({ minutes: service.duration_minutes });

  const now = time.nowInZone(timezone);
  if (startsAt < now.plus({ minutes: MIN_LEAD_MINUTES })) return { error: 'muy_pronto' };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa la creación de citas por negocio para revalidar sin carreras.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [businessId]);

    const { rows: conflicts } = await client.query(
      `SELECT 1 FROM appointments
       WHERE business_id = $1 AND status = ANY($2)
         AND starts_at < $4 AND ends_at > $3
       LIMIT 1`,
      [businessId, ACTIVE_STATUSES, startsAt.toISO(), endsAt.toISO()]
    );
    if (conflicts.length > 0) {
      await client.query('ROLLBACK');
      return { error: 'slot_ocupado' };
    }

    const { rows } = await client.query(
      `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
       RETURNING id`,
      [businessId, serviceId, clientPhone, clientName || null, startsAt.toISO(), endsAt.toISO()]
    );
    await client.query('COMMIT');

    return {
      id: rows[0].id,
      serviceName: service.name,
      price: service.price,
      whenLabel: time.formatDateTime(startsAt),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancela una cita futura del mismo cliente. Devuelve la cita cancelada o un error.
 */
async function cancelAppointment({ businessId, clientPhone, appointmentId }) {
  const { rows } = await db.query(
    `UPDATE appointments
     SET status = 'cancelled'
     WHERE id = $1 AND business_id = $2 AND client_phone = $3
       AND starts_at > now() AND status = ANY($4)
     RETURNING id, starts_at`,
    [appointmentId, businessId, clientPhone, ACTIVE_STATUSES]
  );
  if (rows.length === 0) return { error: 'cita_no_encontrada' };
  return { id: rows[0].id };
}

module.exports = {
  getService,
  listServices,
  getAvailability,
  createAppointment,
  cancelAppointment,
  MIN_LEAD_MINUTES,
  MAX_DAYS_AHEAD,
};
