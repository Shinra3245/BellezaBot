// Middlewares de autenticación y autorización del panel.
// authenticate: valida el JWT y que su tokenVersion siga vigente (permite revocación remota).
// requireRole: restringe una ruta a un rol ('owner' | 'superadmin').
const authService = require('../services/authService');
const { asyncHandler } = require('./errorHandler');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw httpError(401, 'Falta el token de autenticación');
  }

  let payload;
  try {
    payload = authService.verifyToken(token);
  } catch (err) {
    throw httpError(401, 'Token inválido o expirado');
  }

  // Revocación remota: el tokenVersion del JWT debe coincidir con el de la BD.
  const currentVersion = await authService.getTokenVersion(payload.userId);
  if (currentVersion === null || currentVersion !== payload.tokenVersion) {
    throw httpError(401, 'Sesión revocada, inicia sesión de nuevo');
  }

  req.auth = { userId: payload.userId, businessId: payload.businessId, role: payload.role };
  next();
});

function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth || req.auth.role !== role) {
      return next(httpError(403, 'No tienes permiso para esta acción'));
    }
    next();
  };
}

module.exports = { authenticate, requireRole, httpError };
