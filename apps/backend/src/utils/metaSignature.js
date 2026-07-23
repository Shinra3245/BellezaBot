// Validación de la firma X-Hub-Signature-256 que Meta envía en cada webhook.
// La firma es HMAC-SHA256 del cuerpo CRUDO (no del JSON re-serializado) usando META_APP_SECRET.
const crypto = require('crypto');

/**
 * Verifica la firma del webhook contra el raw body.
 * @param {Buffer|string} rawBody cuerpo crudo de la petición (req.rawBody)
 * @param {string} signatureHeader valor del header 'x-hub-signature-256' (formato "sha256=...")
 * @param {string} appSecret META_APP_SECRET
 * @returns {boolean}
 */
function isValidSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret || !rawBody) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // Comparación en tiempo constante; timingSafeEqual exige buffers del mismo largo.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isValidSignature };
