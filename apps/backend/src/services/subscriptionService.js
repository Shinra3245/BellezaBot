// Validación de suscripción del negocio.
// Antes era un middleware de Express que buscaba por req.body.phone (inexistente en el payload
// real de Meta). Ahora es una función pura que recibe el negocio YA resuelto por el webhook.

/**
 * Indica si el negocio tiene el servicio activo (activo y con suscripción vigente).
 * @param {{ is_active: boolean, subscription_expiry: string|Date|null }} business
 * @returns {boolean}
 */
function isSubscriptionActive(business) {
  if (!business || !business.is_active) return false;
  if (!business.subscription_expiry) return false;
  return new Date(business.subscription_expiry) > new Date();
}

// Mensaje fijo cuando el servicio no está disponible (suscripción vencida/inactiva).
const SERVICE_UNAVAILABLE_MESSAGE =
  'Este servicio no está disponible en este momento. Por favor contacta al administrador.';

module.exports = { isSubscriptionActive, SERVICE_UNAVAILABLE_MESSAGE };
