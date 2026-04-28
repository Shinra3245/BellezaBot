const db = require('../config/db');
const { sendWhatsAppMessage } = require('../services/whatsappService');

/**
 * Middleware para verificar si la suscripción de un negocio está activa.
 */
async function checkSubscription(req, res, next) {
    // Lógica para extraer el teléfono del negocio de la petición (ej. del webhook)
    const businessPhone = req.body.phone; // Esto es un ejemplo, ajústalo a la estructura real del webhook

    const result = await db.query(
        'SELECT is_active, subscription_expiry FROM businesses WHERE wa_phone = $1',
        [businessPhone]
    );
    const business = result.rows[0];

    const now = new Date();
    if (!business || !business.is_active || business.subscription_expiry < now) {
        await sendWhatsAppMessage(req.body.phone, "Este servicio no está disponible en este momento. Por favor contacta al administrador.");
        return res.status(403).json({ error: 'Suscripción inactiva o expirada.' });
    }
    next();
}

module.exports = checkSubscription;