/**
 * Servicio para enviar mensajes a través de WhatsApp Business API
 */
async function sendWhatsAppMessage(to, text) {
    console.log(`[WhatsApp Mock] Mensaje enviado a ${to}: ${text}`);
    // Aquí implementaremos la llamada real a la API de Meta Graph en el futuro
}

module.exports = { sendWhatsAppMessage };