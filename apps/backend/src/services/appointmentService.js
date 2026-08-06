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

// Conserva pocas opciones para WhatsApp, pero distribuidas entre apertura y cierre.
function selectRepresentativeSlots(slots) {
  if (slots.length <= MAX_SLOTS) return slots;
  const selected = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const index = Math.round((i * (slots.length - 1)) / (MAX_SLOTS - 1));
    if (!selected.includes(slots[index])) selected.push(slots[index]);
  }
  return selected;
}

function validateBookingWindow(startsAt, timezone) {
  const now = time.nowInZone(timezone);
  if (startsAt < now.plus({ minutes: MIN_LEAD_MINUTES })) return 'muy_pronto';

  const daysAhead = startsAt.startOf('day').diff(now.startOf('day'), 'days').days;
  if (daysAhead > MAX_DAYS_AHEAD) return 'fecha_fuera_de_ventana';
  return null;
}

function fitsConfiguredSchedule(startsAt, endsAt, schedules, durationMinutes) {
  const dayStart = startsAt.startOf('day');
  const stepMinutes = durationMinutes + BUFFER_MINUTES;

  return schedules.some((schedule) => {
    const windowStart = time.atTime(dayStart, schedule.start_time);
    const windowEnd = time.atTime(dayStart, schedule.end_time);
    const offsetMinutes = startsAt.diff(windowStart, 'minutes').minutes;
    const aligned =
      offsetMinutes >= 0 && Math.abs(offsetMinutes / stepMinutes - Math.round(offsetMinutes / stepMinutes)) < 1e-8;
    return aligned && endsAt <= windowEnd;
  });
}

// Debe ejecutarse después de adquirir el advisory lock del negocio.
async function validateSlotInTransaction(
  client,
  { businessId, startsAt, endsAt, durationMinutes, excludeAppointmentId = null }
) {
  const dayOfWeek = time.jsDayOfWeek(startsAt);
  const { rows: schedules } = await client.query(
    `SELECT start_time, end_time FROM schedules
     WHERE business_id = $1 AND day_of_week = $2
     ORDER BY start_time`,
    [businessId, dayOfWeek]
  );

  if (!fitsConfiguredSchedule(startsAt, endsAt, schedules, durationMinutes)) {
    return 'fuera_de_horario';
  }

  const appointmentParams = [businessId, ACTIVE_STATUSES, startsAt.toISO(), endsAt.toISO()];
  let exclusion = '';
  if (excludeAppointmentId) {
    appointmentParams.push(excludeAppointmentId);
    exclusion = `AND id <> $${appointmentParams.length}`;
  }

  const { rows: appointmentConflicts } = await client.query(
    `SELECT 1 FROM appointments
     WHERE business_id = $1 AND status = ANY($2) ${exclusion}
       AND starts_at < $4 AND ends_at > $3
     LIMIT 1`,
    appointmentParams
  );
  if (appointmentConflicts.length > 0) return 'slot_ocupado';

  const { rows: blockConflicts } = await client.query(
    `SELECT 1 FROM blocks
     WHERE business_id = $1 AND starts_at < $3 AND ends_at > $2
     LIMIT 1`,
    [businessId, startsAt.toISO(), endsAt.toISO()]
  );
  if (blockConflicts.length > 0) return 'slot_bloqueado';

  return null;
}

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

// Bloqueos de horario que se solapan con una ventana [from, to) para un negocio.
async function getOverlappingBlocks(businessId, fromISO, toISO) {
  const { rows } = await db.query(
    `SELECT starts_at, ends_at
     FROM blocks
     WHERE business_id = $1
       AND starts_at < $3 AND ends_at > $2`,
    [businessId, fromISO, toISO]
  );
  return rows;
}

/**
 * Calcula los huecos libres para un día y servicio.
 * @returns {Promise<{ slots: Array<{datetime_iso, label}>, closed: boolean, past: boolean, tooFar: boolean }>}
 */
async function getAvailability({ businessId, date, serviceId, timezone, preferredTime = null }) {
  const service = await getService(businessId, serviceId);
  if (!service) return { error: 'servicio_no_encontrado' };

  const dayStart = time.startOfDay(date, timezone);
  if (!dayStart.isValid) return { error: 'fecha_invalida' };
  if (preferredTime !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferredTime)) {
    return { error: 'hora_invalida' };
  }
  const preferredStart = preferredTime ? time.atTime(dayStart, preferredTime) : null;

  const now = time.nowInZone(timezone);
  const daysAhead = dayStart.diff(now.startOf('day'), 'days').days;
  // Distinguir una fecha pasada evita que la IA confunda sus slots vacíos con falta de disponibilidad.
  if (daysAhead < 0) {
    return { slots: [], past: true };
  }
  // No agendar más allá de la ventana máxima.
  if (daysAhead > MAX_DAYS_AHEAD) {
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
  const [busy, blocks] = await Promise.all([
    getOverlappingAppointments(businessId, dayStart.toISO(), dayEnd.toISO()),
    getOverlappingBlocks(businessId, dayStart.toISO(), dayEnd.toISO()),
  ]);
  // Citas ocupadas y bloqueos de la dueña cuentan igual como "no disponible".
  const busyIntervals = busy.concat(blocks).map((a) => ({
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

      const matchesPreferredTime = !preferredStart || slotStart.toMillis() === preferredStart.toMillis();
      if (!inPast && !overlaps && matchesPreferredTime) {
        slots.push({ datetime_iso: slotStart.toISO(), label: time.formatTime(slotStart) });
      }
      slotStart = slotStart.plus({ minutes: duration + BUFFER_MINUTES });
    }
  }

  return { slots: preferredStart ? slots : selectRepresentativeSlots(slots) };
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

  const windowError = validateBookingWindow(startsAt, timezone);
  if (windowError) return { error: windowError };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa la creación de citas por negocio para revalidar sin carreras.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [businessId]);

    const slotError = await validateSlotInTransaction(client, {
      businessId,
      startsAt,
      endsAt,
      durationMinutes: service.duration_minutes,
    });
    if (slotError) {
      await client.query('ROLLBACK');
      return { error: slotError };
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

// ---------------------------------------------------------------------------
// Funciones de administración (modo dueña). El business_id SIEMPRE viene del
// contexto del servidor: la dueña solo puede ver/tocar citas de SU negocio.
// ---------------------------------------------------------------------------

/**
 * Lista las citas de un día (todas menos las canceladas) con datos de la clienta y el servicio.
 * @returns {Promise<Array>} citas ordenadas por hora de inicio.
 */
async function getAppointmentsByDate({ businessId, date, timezone }) {
  const dayStart = time.startOfDay(date, timezone);
  if (!dayStart.isValid) return { error: 'fecha_invalida' };
  const dayEnd = dayStart.plus({ days: 1 });

  const { rows } = await db.query(
    `SELECT a.id, a.client_name, a.client_phone, a.starts_at, a.status,
            s.name AS service_name
     FROM appointments a
     JOIN services s ON s.id = a.service_id
     WHERE a.business_id = $1
       AND a.starts_at >= $2 AND a.starts_at < $3
       AND a.status <> 'cancelled'
     ORDER BY a.starts_at`,
    [businessId, dayStart.toISO(), dayEnd.toISO()]
  );
  return {
    appointments: rows.map((r) => ({
      id: r.id,
      client_name: r.client_name,
      client_phone: r.client_phone,
      service_name: r.service_name,
      status: r.status,
      when: time.formatTime(time.DateTime.fromJSDate(r.starts_at).setZone(timezone)),
      starts_at: r.starts_at,
    })),
  };
}

// Carga una cita futura del negocio (con datos para notificar a la clienta).
async function getFutureAppointment(businessId, appointmentId, clientPhone = null) {
  const { rows } = await db.query(
    `SELECT a.id, a.client_name, a.client_phone, a.starts_at, a.service_id, a.status,
            s.name AS service_name, s.duration_minutes
     FROM appointments a
     JOIN services s ON s.id = a.service_id
     WHERE a.id = $1 AND a.business_id = $2
       AND ($3::text IS NULL OR a.client_phone = $3)
       AND a.starts_at > now() AND a.status = ANY($4)`,
    [appointmentId, businessId, clientPhone, ACTIVE_STATUSES]
  );
  return rows[0] || null;
}

// Próximas citas activas de una clienta. Le permite identificar una cita sin conocer su UUID.
async function getUpcomingAppointments({ businessId, clientPhone, timezone, limit = 10 }) {
  const { rows } = await db.query(
    `SELECT a.id, a.starts_at, a.status, s.name AS service_name
     FROM appointments a
     JOIN services s ON s.id = a.service_id
     WHERE a.business_id = $1 AND a.client_phone = $2
       AND a.starts_at > now() AND a.status = ANY($3)
     ORDER BY a.starts_at
     LIMIT $4`,
    [businessId, clientPhone, ACTIVE_STATUSES, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    serviceName: row.service_name,
    status: row.status,
    whenLabel: time.formatDateTime(time.DateTime.fromJSDate(row.starts_at).setZone(timezone)),
    startsAt: row.starts_at,
  }));
}

/**
 * La dueña cancela cualquier cita futura de SU negocio.
 * @returns la cita cancelada (con datos de la clienta para avisarle) o un error.
 */
async function cancelAppointmentAdmin({ businessId, appointmentId }) {
  const appt = await getFutureAppointment(businessId, appointmentId);
  if (!appt) return { error: 'cita_no_encontrada' };

  const { rows } = await db.query(
    `UPDATE appointments SET status = 'cancelled'
     WHERE id = $1 AND business_id = $2 AND starts_at > now() AND status = ANY($3)
     RETURNING id`,
    [appointmentId, businessId, ACTIVE_STATUSES]
  );
  if (rows.length === 0) return { error: 'cita_no_encontrada' };
  return {
    id: appt.id,
    clientPhone: appt.client_phone,
    clientName: appt.client_name,
    serviceName: appt.service_name,
  };
}

/**
 * La dueña reprograma una cita a un nuevo horario, revalidando disponibilidad
 * (mismo lock por negocio que createAppointment; excluye la propia cita del conflicto).
 * @returns datos para notificar a la clienta o un error.
 */
async function rescheduleAppointment({
  businessId,
  appointmentId,
  newDatetimeIso,
  timezone,
  clientPhone = null,
}) {
  const appt = await getFutureAppointment(businessId, appointmentId, clientPhone);
  if (!appt) return { error: 'cita_no_encontrada' };

  const startsAt = time.parseISO(newDatetimeIso, timezone);
  if (!startsAt.isValid) return { error: 'fecha_invalida' };
  const endsAt = startsAt.plus({ minutes: appt.duration_minutes });

  const windowError = validateBookingWindow(startsAt, timezone);
  if (windowError) return { error: windowError };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [businessId]);

    const slotError = await validateSlotInTransaction(client, {
      businessId,
      startsAt,
      endsAt,
      durationMinutes: appt.duration_minutes,
      excludeAppointmentId: appointmentId,
    });
    if (slotError) {
      await client.query('ROLLBACK');
      return { error: slotError };
    }

    const { rows: updated } = await client.query(
      `UPDATE appointments SET starts_at = $1, ends_at = $2, status = 'rescheduled', reminder_sent_at = NULL
       WHERE id = $3 AND business_id = $4
         AND ($5::text IS NULL OR client_phone = $5)
         AND starts_at > now() AND status = ANY($6)
       RETURNING id`,
      [startsAt.toISO(), endsAt.toISO(), appointmentId, businessId, clientPhone, ACTIVE_STATUSES]
    );
    if (updated.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'cita_no_encontrada' };
    }
    await client.query('COMMIT');

    return {
      id: appt.id,
      clientPhone: appt.client_phone,
      clientName: appt.client_name,
      serviceName: appt.service_name,
      whenLabel: time.formatDateTime(startsAt),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function rescheduleAppointmentAdmin(args) {
  return rescheduleAppointment(args);
}

async function rescheduleAppointmentClient(args) {
  return rescheduleAppointment(args);
}

/**
 * Crea un bloqueo de horario (rango no disponible) que check_availability respeta.
 */
async function createBlock({ businessId, date, startTime, endTime, reason, timezone }) {
  const dayStart = time.startOfDay(date, timezone);
  if (!dayStart.isValid) return { error: 'fecha_invalida' };
  const startsAt = time.atTime(dayStart, startTime);
  const endsAt = time.atTime(dayStart, endTime);
  if (!startsAt.isValid || !endsAt.isValid || endsAt <= startsAt) return { error: 'rango_invalido' };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
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
      return { error: 'hay_citas_en_el_rango' };
    }

    const { rows } = await client.query(
      `INSERT INTO blocks (business_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [businessId, startsAt.toISO(), endsAt.toISO(), reason || null]
    );
    await client.query('COMMIT');
    return {
      id: rows[0].id,
      whenLabel: `${time.formatDateTime(startsAt)} a ${time.formatTime(endsAt)}`,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resumen de la semana que contiene `date` (o la actual): conteo por día y estado.
 */
async function getWeekSummary({ businessId, timezone, date = null }) {
  const referenceDate = date ? time.startOfDay(date, timezone) : time.nowInZone(timezone);
  if (!referenceDate.isValid) return { error: 'fecha_invalida' };
  const weekStart = referenceDate.startOf('week'); // luxon: lunes
  const weekEnd = weekStart.plus({ days: 7 });

  const { rows } = await db.query(
    `SELECT starts_at, status FROM appointments
     WHERE business_id = $1 AND status <> 'cancelled'
       AND starts_at >= $2 AND starts_at < $3
     ORDER BY starts_at`,
    [businessId, weekStart.toISO(), weekEnd.toISO()]
  );

  const byDay = {};
  const byStatus = {};
  for (const r of rows) {
    const dayLabel = time.DateTime.fromJSDate(r.starts_at).setZone(timezone).setLocale('es').toFormat('cccc');
    byDay[dayLabel] = (byDay[dayLabel] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  return {
    total: rows.length,
    byDay,
    byStatus,
    from: weekStart.toFormat('yyyy-LL-dd'),
    to: weekEnd.minus({ days: 1 }).toFormat('yyyy-LL-dd'),
  };
}

module.exports = {
  getService,
  listServices,
  getAvailability,
  createAppointment,
  cancelAppointment,
  getUpcomingAppointments,
  getAppointmentsByDate,
  cancelAppointmentAdmin,
  rescheduleAppointmentAdmin,
  rescheduleAppointmentClient,
  createBlock,
  getWeekSummary,
  MIN_LEAD_MINUTES,
  MAX_DAYS_AHEAD,
};
