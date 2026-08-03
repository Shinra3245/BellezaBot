// API del panel de la dueña. Todas las rutas exigen JWT válido y rol 'owner'.
// El businessId SIEMPRE sale de req.auth (JWT), nunca del cliente → aislamiento multi-tenant.
const express = require('express');
const time = require('../utils/time');
const panelService = require('../services/panelService');
const appointmentService = require('../services/appointmentService');
const whatsappService = require('../services/whatsappService');
const adminTools = require('../tools/adminTools');
const { asyncHandler } = require('../middlewares/errorHandler');
const { authenticate, requireRole, httpError } = require('../middlewares/auth');

const router = express.Router();
router.use(authenticate, requireRole('owner'));

const bid = (req) => req.auth.businessId;

// --- Citas ---
router.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const business = await panelService.getBusiness(bid(req));
    const tz = business.timezone;
    const from = req.query.from || time.nowInZone(tz).toFormat('yyyy-LL-dd');
    const to = req.query.to || from;
    const fromISO = time.startOfDay(from, tz);
    const toISO = time.startOfDay(to, tz).plus({ days: 1 });
    if (!fromISO.isValid || !toISO.isValid) throw httpError(400, 'Rango de fechas inválido');
    const rows = await panelService.listAppointments(bid(req), fromISO.toISO(), toISO.toISO());
    res.json({ appointments: rows });
  })
);

// PATCH /appointments/:id — cambiar estado, o reprogramar si viene starts_at (dispara plantilla).
router.patch(
  '/appointments/:id',
  asyncHandler(async (req, res) => {
    const { status, starts_at } = req.body || {};

    if (starts_at) {
      const business = await panelService.getBusiness(bid(req));
      const result = await appointmentService.rescheduleAppointmentAdmin({
        businessId: bid(req),
        appointmentId: req.params.id,
        newDatetimeIso: starts_at,
        timezone: business.timezone,
      });
      if (result.error) throw httpError(mapApptError(result.error), result.error);
      // Avisar a la clienta con la plantilla aprobada (mismo comportamiento que el modo admin).
      await whatsappService.sendTemplateMessage(
        business.wa_phone_number_id,
        result.clientPhone,
        adminTools.RESCHEDULE_TEMPLATE,
        [result.clientName || 'cliente', result.serviceName, result.whenLabel]
      );
      return res.json({ ok: true, reprogramada: result.id, nuevo_horario: result.whenLabel });
    }

    if (status) {
      const VALID = ['pending', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show'];
      if (!VALID.includes(status)) throw httpError(400, 'Estado inválido');
      const result = await panelService.updateAppointmentStatus(bid(req), req.params.id, status);
      if (result.error) throw httpError(404, 'Cita no encontrada');
      return res.json({ ok: true, cita: result });
    }

    throw httpError(400, 'Nada que actualizar: envía status o starts_at');
  })
);

// --- Servicios (CRUD) ---
router.get('/services', asyncHandler(async (req, res) => {
  res.json({ services: await panelService.listServices(bid(req)) });
}));

router.post('/services', asyncHandler(async (req, res) => {
  const { name, price, duration_minutes } = req.body || {};
  if (!name || price === undefined || !duration_minutes) {
    throw httpError(400, 'name, price y duration_minutes son obligatorios');
  }
  res.status(201).json({ service: await panelService.createService(bid(req), { name, price, duration_minutes }) });
}));

router.patch('/services/:id', asyncHandler(async (req, res) => {
  const result = await panelService.updateService(bid(req), req.params.id, req.body || {});
  if (result.error === 'no_encontrado') throw httpError(404, 'Servicio no encontrado');
  if (result.error === 'sin_cambios') throw httpError(400, 'Sin campos válidos para actualizar');
  res.json({ service: result });
}));

router.delete('/services/:id', asyncHandler(async (req, res) => {
  const ok = await panelService.deactivateService(bid(req), req.params.id);
  if (!ok) throw httpError(404, 'Servicio no encontrado');
  res.json({ ok: true });
}));

// --- Horarios (CRUD) ---
router.get('/schedules', asyncHandler(async (req, res) => {
  res.json({ schedules: await panelService.listSchedules(bid(req)) });
}));

router.post('/schedules', asyncHandler(async (req, res) => {
  const { day_of_week, start_time, end_time } = req.body || {};
  if (day_of_week === undefined || !start_time || !end_time) {
    throw httpError(400, 'day_of_week, start_time y end_time son obligatorios');
  }
  if (day_of_week < 0 || day_of_week > 6) throw httpError(400, 'day_of_week debe estar entre 0 y 6');
  res.status(201).json({ schedule: await panelService.createSchedule(bid(req), { day_of_week, start_time, end_time }) });
}));

router.delete('/schedules/:id', asyncHandler(async (req, res) => {
  const ok = await panelService.deleteSchedule(bid(req), req.params.id);
  if (!ok) throw httpError(404, 'Horario no encontrado');
  res.json({ ok: true });
}));

// --- Configuración del negocio/bot ---
router.get('/business', asyncHandler(async (req, res) => {
  res.json({ business: await panelService.getBusiness(bid(req)) });
}));

router.patch('/business', asyncHandler(async (req, res) => {
  const result = await panelService.updateBusiness(bid(req), req.body || {});
  if (result.error === 'sin_cambios') throw httpError(400, 'Sin campos válidos para actualizar');
  res.json({ business: result });
}));

// Mapea errores de reprogramación a códigos HTTP.
function mapApptError(err) {
  if (err === 'cita_no_encontrada') return 404;
  if (err === 'slot_ocupado' || err === 'muy_pronto' || err === 'fecha_invalida') return 409;
  return 400;
}

module.exports = router;
