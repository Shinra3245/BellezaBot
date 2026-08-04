// Rutas de autenticación del panel.
const express = require('express');
const authService = require('../services/authService');
const loginAttemptService = require('../services/loginAttemptService');
const { asyncHandler } = require('../middlewares/errorHandler');
const { authenticate, httpError } = require('../middlewares/auth');

const router = express.Router();

// POST /auth/login → { email, password } → { token, user }
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'Email y contraseña son obligatorios');

    const normalizedEmail = String(email).toLowerCase().trim();
    const limit = loginAttemptService.check(req.ip, normalizedEmail);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfterSeconds));
      throw httpError(429, 'Demasiados intentos. Intenta nuevamente en unos minutos');
    }

    const result = await authService.login(normalizedEmail, String(password));
    if (!result) {
      loginAttemptService.recordFailure(req.ip, normalizedEmail);
      throw httpError(401, 'Credenciales inválidas');
    }
    loginAttemptService.clear(req.ip, normalizedEmail);

    res.json(result);
  })
);

// GET /auth/me → datos del usuario autenticado (útil para el frontend al recargar).
router.get(
  '/me',
  authenticate,
  (req, res) => {
    res.json({ user: req.auth });
  }
);

module.exports = router;
