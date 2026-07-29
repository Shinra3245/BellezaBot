// Recordatorios de citas: cron cada 15 min que avisa 24h antes de la cita.
// Usa el índice parcial idx_appointments_reminders (status='confirmed' AND reminder_sent_at IS NULL).
const cron = require('node-cron');
const db = require('../config/db');
const time = require('../utils/time');
const logger = require('../utils/logger');
const whatsappService = require('./whatsappService');
const conversationService = require('./conversationService');

const REMINDER_TEMPLATE = 'recordatorio_cita';

// Citas confirmadas que empiezan en las próximas 24h y aún no tienen recordatorio.
async function findDueReminders() {
  const { rows } = await db.query(
    `SELECT a.id, a.client_phone, a.client_name, a.starts_at,
            s.name AS service_name,
            b.id AS business_id, b.wa_phone_number_id, b.timezone
     FROM appointments a
     JOIN services s ON s.id = a.service_id
     JOIN businesses b ON b.id = a.business_id
     WHERE a.status = 'confirmed'
       AND a.reminder_sent_at IS NULL
       AND a.starts_at > now()
       AND a.starts_at <= now() + interval '24 hours'`
  );
  return rows;
}

// Marca de forma atómica una cita como "recordatorio enviado". Evita duplicados si dos
// corridas del cron se solapan: solo una logra el UPDATE (WHERE reminder_sent_at IS NULL).
async function claimReminder(appointmentId) {
  const { rows } = await db.query(
    `UPDATE appointments SET reminder_sent_at = now()
     WHERE id = $1 AND reminder_sent_at IS NULL
     RETURNING id`,
    [appointmentId]
  );
  return rows.length === 1;
}

/**
 * Ejecuta una pasada de recordatorios. Devuelve cuántos se enviaron.
 * @param {{ sendTemplateMessage? }} [deps] inyección para pruebas.
 */
async function runOnce(deps = {}) {
  const sendTemplate = deps.sendTemplateMessage || whatsappService.sendTemplateMessage;
  const due = await findDueReminders();
  let sent = 0;

  for (const appt of due) {
    // Reclamar antes de enviar → sin duplicados ante solapamiento del cron.
    const claimed = await claimReminder(appt.id);
    if (!claimed) continue;

    const whenLabel = time.formatTime(time.DateTime.fromJSDate(appt.starts_at).setZone(appt.timezone));
    try {
      const result = await sendTemplate(
        appt.wa_phone_number_id,
        appt.client_phone,
        REMINDER_TEMPLATE,
        [appt.client_name || 'cliente', appt.service_name, whenLabel]
      );
      // Si Meta rechaza el envío (p. ej. plantilla no aprobada aún), tratarlo como fallo.
      if (result && result.ok === false) throw new Error('envío rechazado por Meta');

      // Guardar el recordatorio en la conversación para que la IA tenga contexto
      // si la clienta responde "No" y hay que reprogramar.
      const conversationId = await conversationService.getOrCreate(appt.business_id, appt.client_phone);
      await conversationService.saveOutboundMessage({
        conversationId,
        content: `Recordatorio enviado: tu cita de ${appt.service_name} es mañana a las ${whenLabel}. ¿Confirmas tu asistencia? Responde Sí o No.`,
      });
      sent += 1;
    } catch (err) {
      // Liberar la cita para reintentar en la próxima corrida (no perder el recordatorio).
      await db.query('UPDATE appointments SET reminder_sent_at = NULL WHERE id = $1', [appt.id]).catch(() => {});
      logger.error('Error enviando recordatorio; se reintentará', {
        business_id: appt.business_id, appointment_id: appt.id, error: err.message,
      });
    }
  }

  if (sent > 0) logger.info('Recordatorios enviados', { count: sent });
  return sent;
}

// Arranca el cron cada 15 minutos. Se llama desde server.js (no en pruebas).
function startCron() {
  cron.schedule('*/15 * * * *', () => {
    runOnce().catch((err) => logger.error('Fallo en el cron de recordatorios', { error: err.message }));
  });
  logger.info('Cron de recordatorios activo (cada 15 min)');
}

module.exports = { runOnce, findDueReminders, startCron, REMINDER_TEMPLATE };
