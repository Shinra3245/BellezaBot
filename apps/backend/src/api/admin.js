// API del super-admin (dueño del SaaS). Todas las rutas exigen JWT válido y rol 'superadmin'.
const express = require('express');
const superAdminService = require('../services/superAdminService');
const validation = require('../utils/validation');
const { asyncHandler } = require('../middlewares/errorHandler');
const { authenticate, requireRole, httpError } = require('../middlewares/auth');

const router = express.Router();
router.use(authenticate, requireRole('superadmin'));

// GET /admin/businesses — todos los negocios con estado de suscripción.
router.get('/businesses', asyncHandler(async (req, res) => {
  res.json({ businesses: await superAdminService.listBusinesses() });
}));

// POST /admin/businesses — alta manual de negocio + usuario owner.
router.post('/businesses', asyncHandler(async (req, res) => {
  const { name, wa_phone, ownerEmail, ownerPassword } = req.body || {};
  if (!validation.isNonEmptyString(name) || !validation.isValidE164(wa_phone) ||
      !validation.isValidEmail(ownerEmail) || typeof ownerPassword !== 'string' || ownerPassword.length < 16) {
    throw httpError(400, 'name, wa_phone, ownerEmail y ownerPassword son obligatorios');
  }
  if (req.body.owner_phone && !validation.isValidE164(req.body.owner_phone)) {
    throw httpError(400, 'owner_phone debe tener formato E.164');
  }
  if (req.body.timezone && !validation.isValidTimezone(req.body.timezone)) {
    throw httpError(400, 'Zona horaria inválida');
  }
  if (req.body.subscriptionDays !== undefined &&
      (!Number.isInteger(Number(req.body.subscriptionDays)) || Number(req.body.subscriptionDays) < 1 || Number(req.body.subscriptionDays) > 3650)) {
    throw httpError(400, 'subscriptionDays debe ser un entero entre 1 y 3650');
  }
  const result = await superAdminService.createBusiness(req.body);
  if (result.error === 'duplicado') throw httpError(409, 'Ya existe un negocio o usuario con esos datos');
  res.status(201).json(result);
}));

// PATCH /admin/businesses/:id — actualizar suscripción / activación.
router.patch('/businesses/:id', asyncHandler(async (req, res) => {
  if (req.body?.is_active !== undefined && typeof req.body.is_active !== 'boolean') {
    throw httpError(400, 'is_active debe ser booleano');
  }
  if (req.body?.subscription_expiry !== undefined) {
    const expiry = new Date(req.body.subscription_expiry);
    if (Number.isNaN(expiry.getTime())) throw httpError(400, 'subscription_expiry no es una fecha válida');
  }
  const result = await superAdminService.updateBusiness(req.params.id, req.body || {});
  if (result.error === 'no_encontrado') throw httpError(404, 'Negocio no encontrado');
  if (result.error === 'sin_cambios') throw httpError(400, 'Sin campos válidos para actualizar');
  res.json({ business: result });
}));

// POST /admin/users/:id/revoke-tokens — invalida todas las sesiones del usuario.
router.post('/users/:id/revoke-tokens', asyncHandler(async (req, res) => {
  const result = await superAdminService.revokeUserTokens(req.params.id);
  if (result.error === 'no_encontrado') throw httpError(404, 'Usuario no encontrado');
  res.json({ ok: true, token_version: result.token_version });
}));

module.exports = router;
