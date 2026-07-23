// Resolución del negocio (tenant) a partir de datos del webhook.
const db = require('../config/db');

/**
 * Resuelve el negocio por el phone_number_id de Meta (identifica al tenant en el webhook).
 * @returns {Promise<object|null>} el negocio o null si no existe
 */
async function getByPhoneNumberId(phoneNumberId) {
  const { rows } = await db.query(
    `SELECT id, name, wa_phone, wa_phone_number_id, owner_phone, timezone,
            bot_name, bot_personality, tone, is_active, subscription_expiry
     FROM businesses
     WHERE wa_phone_number_id = $1`,
    [phoneNumberId]
  );
  return rows[0] || null;
}

module.exports = { getByPhoneNumberId };
