// Operaciones del panel del negocio (dueña). TODO filtrado por businessId, que SIEMPRE
// viene del JWT (req.auth.businessId), nunca del body ni de params.
const db = require('../config/db');

// --- Servicios -------------------------------------------------------------
// Incluye inactivos: el panel los administra; el bot (appointmentService) solo usa los activos.
async function listServices(businessId) {
  const { rows } = await db.query(
    `SELECT id, name, price, duration_minutes, is_active, created_at
     FROM services WHERE business_id = $1 ORDER BY created_at`,
    [businessId]
  );
  return rows;
}

async function createService(businessId, { name, price, duration_minutes }) {
  const { rows } = await db.query(
    `INSERT INTO services (business_id, name, price, duration_minutes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, price, duration_minutes, is_active`,
    [businessId, name, price, duration_minutes]
  );
  return rows[0];
}

// Actualiza solo los campos permitidos de un servicio del propio negocio.
async function updateService(businessId, serviceId, fields) {
  const allowed = ['name', 'price', 'duration_minutes', 'is_active'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) return { error: 'sin_cambios' };
  values.push(serviceId, businessId);
  const { rows } = await db.query(
    `UPDATE services SET ${sets.join(', ')}
     WHERE id = $${values.length - 1} AND business_id = $${values.length}
     RETURNING id, name, price, duration_minutes, is_active`,
    values
  );
  if (rows.length === 0) return { error: 'no_encontrado' };
  return rows[0];
}

// Baja lógica (no borra: preserva integridad con citas históricas).
async function deactivateService(businessId, serviceId) {
  const { rows } = await db.query(
    `UPDATE services SET is_active = false
     WHERE id = $1 AND business_id = $2 RETURNING id`,
    [serviceId, businessId]
  );
  return rows.length > 0;
}

// --- Horarios --------------------------------------------------------------
async function listSchedules(businessId) {
  const { rows } = await db.query(
    `SELECT id, day_of_week, start_time, end_time
     FROM schedules WHERE business_id = $1 ORDER BY day_of_week, start_time`,
    [businessId]
  );
  return rows;
}

async function createSchedule(businessId, { day_of_week, start_time, end_time }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO schedules (business_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4) RETURNING id, day_of_week, start_time, end_time`,
      [businessId, day_of_week, start_time, end_time]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'schedules_business_day_time_key') {
      return { error: 'duplicado' };
    }
    throw err;
  }
}

async function deleteSchedule(businessId, scheduleId) {
  const { rows } = await db.query(
    `DELETE FROM schedules WHERE id = $1 AND business_id = $2 RETURNING id`,
    [scheduleId, businessId]
  );
  return rows.length > 0;
}

// --- Configuración del negocio (bot) ---------------------------------------
async function getBusiness(businessId) {
  const { rows } = await db.query(
    `SELECT id, name, wa_phone, wa_phone_number_id, owner_phone, timezone,
            bot_name, bot_personality, tone, is_active, subscription_expiry
     FROM businesses WHERE id = $1`,
    [businessId]
  );
  return rows[0] || null;
}

async function updateBusiness(businessId, fields) {
  // La dueña solo puede tocar la config del bot y su owner_phone (no is_active ni suscripción).
  const allowed = ['name', 'owner_phone', 'timezone', 'bot_name', 'bot_personality', 'tone'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) return { error: 'sin_cambios' };
  values.push(businessId);
  const { rows } = await db.query(
    `UPDATE businesses SET ${sets.join(', ')} WHERE id = $${values.length}
     RETURNING id, name, owner_phone, timezone, bot_name, bot_personality, tone`,
    values
  );
  return rows[0];
}

// --- Citas del panel -------------------------------------------------------
async function listAppointments(businessId, fromISO, toISO) {
  const { rows } = await db.query(
    `SELECT a.id, a.client_name, a.client_phone, a.starts_at, a.ends_at, a.status,
            s.name AS service_name, s.id AS service_id
     FROM appointments a
     JOIN services s ON s.id = a.service_id
     WHERE a.business_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
     ORDER BY a.starts_at`,
    [businessId, fromISO, toISO]
  );
  return rows;
}

// Cambia el estado de una cita del propio negocio (completed, no_show, cancelled, etc.).
async function updateAppointmentStatus(businessId, appointmentId, status) {
  const { rows } = await db.query(
    `UPDATE appointments SET status = $3
     WHERE id = $1 AND business_id = $2
     RETURNING id, status`,
    [appointmentId, businessId, status]
  );
  if (rows.length === 0) return { error: 'no_encontrada' };
  return rows[0];
}

module.exports = {
  listServices,
  createService,
  updateService,
  deactivateService,
  listSchedules,
  createSchedule,
  deleteSchedule,
  getBusiness,
  updateBusiness,
  listAppointments,
  updateAppointmentStatus,
};
