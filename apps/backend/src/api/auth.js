// Rutas de autenticación del panel.
const express = require('express');
const authService = require('../services/authService');
const { asyncHandler } = require('../middlewares/errorHandler');
const { authenticate, httpError } = require('../middlewares/auth');

const router = express.Router();

// POST /auth/login → { email, password } → { token, user }
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'Email y contraseña son obligatorios');

    const result = await authService.login(String(email).toLowerCase().trim(), String(password));
    if (!result) throw httpError(401, 'Credenciales inválidas');

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
