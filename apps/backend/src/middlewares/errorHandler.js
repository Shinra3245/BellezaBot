// Manejo centralizado de errores + wrapper para rutas async.
// Express 4 no captura los rechazos de promesas automáticamente: asyncHandler
// los reenvía a next() para que lleguen a este errorHandler.

/**
 * Envuelve un handler async y reenvía cualquier error a next().
 * @param {Function} fn handler(req, res, next)
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Middleware de manejo de errores. Debe registrarse como ÚLTIMO middleware.
 */
// eslint-disable-next-line no-unused-vars -- Express identifica el error handler por su aridad (4 args)
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  // Log del error del lado servidor (sin filtrar detalles internos al cliente en 5xx).
  console.error(`[error] ${req.method} ${req.originalUrl} → ${status}:`, err.message);
  if (status >= 500) {
    console.error(err.stack);
  }

  const body = { error: status >= 500 ? 'Error interno del servidor' : err.message };
  res.status(status).json(body);
}

module.exports = { asyncHandler, errorHandler };
