// CORS mínimo para el panel web, sin dependencia externa.
// En producción se restringe a los orígenes de FRONTEND_URL (lista separada por comas);
// en desarrollo se permite cualquier origen para facilitar pruebas locales.
const env = require('../config/env');

const allowedOrigins = (env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed(origin) {
  if (env.NODE_ENV !== 'production') return true; // dev: cualquier origen
  return allowedOrigins.includes(origin);
}

function corsMiddleware(req, res, next) {
  const origin = req.get('origin');
  if (origin && isAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '86400');
  }
  // Responder los preflight sin pasar por el resto de la cadena.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = { corsMiddleware };
