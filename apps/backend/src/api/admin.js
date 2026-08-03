// API del super-admin (dueño del SaaS). Todas las rutas exigen JWT válido y rol 'superadmin'.
const express = require('express');
const superAdminService = require('../services/superAdminService');
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
  if (!name || !wa_phone || !ownerEmail || !ownerPassword) {
    throw httpError(400, 'name, wa_phone, ownerEmail y ownerPassword son obligatorios');
  }
  const result = await superAdminService.createBusiness(req.body);
  if (result.error === 'duplicado') throw httpError(409, 'Ya existe un negocio o usuario con esos datos');
  res.status(201).json(result);
}));

// PATCH /admin/businesses/:id — actualizar suscripción / activación.
router.patch('/businesses/:id', asyncHandler(async (req, res) => {
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
