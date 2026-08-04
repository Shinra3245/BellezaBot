const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
const reminderService = require('../src/services/reminderService');

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const MANICURE_ID = '22222222-2222-2222-2222-222222222201';
const PHONE = 'remclient1';
const TZ = 'America/Mexico_City';

async function cleanup() {
  await db.query(
    `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE client_phone LIKE 'remclient%')`
  );
  await db.query(`DELETE FROM conversations WHERE client_phone LIKE 'remclient%'`);
  await db.query(`DELETE FROM appointments WHERE client_phone LIKE 'remclient%'`);
}

before(cleanup);
after(async () => {
  await cleanup();
  await db.pool.end();
});

// Cliente falso de plantillas: registra las llamadas.
function fakeTemplateSender() {
  const calls = [];
  return {
    calls,
    fn: async (phoneNumberId, to, templateName, params) => {
      calls.push({ phoneNumberId, to, templateName, params });
      return { ok: true };
    },
  };
}

test('runOnce envía recordatorio de citas dentro de 24h y no las reenvía', async () => {
  // Mismo horario local de mañana menos 30 minutos: está dentro de 24h y sí es "mañana".
  const startsAt = DateTime.now().setZone(TZ).plus({ days: 1 }).minus({ minutes: 30 });
  const { rows } = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, 'Ana', $4, $5, 'confirmed')
     RETURNING id`,
    [BUSINESS_ID, MANICURE_ID, PHONE, startsAt.toISO(), startsAt.plus({ minutes: 45 }).toISO()]
  );
  const apptId = rows[0].id;

  const sender = fakeTemplateSender();
  const sent = await reminderService.runOnce({ sendTemplateMessage: sender.fn });
  assert.ok(sent >= 1);

  const mine = sender.calls.find((c) => c.to === PHONE);
  assert.ok(mine, 'debió enviarse el recordatorio a este cliente');
  assert.strictEqual(mine.templateName, 'recordatorio_cita');
  assert.strictEqual(mine.params[0], 'Ana'); // nombre
  assert.strictEqual(mine.params[1], 'Manicure'); // servicio

  // reminder_sent_at quedó marcado.
  const check = await db.query('SELECT reminder_sent_at FROM appointments WHERE id = $1', [apptId]);
  assert.ok(check.rows[0].reminder_sent_at, 'reminder_sent_at debe quedar marcado');

  // El recordatorio se guardó en la conversación (contexto para reprogramar).
  const msgs = await db.query(
    `SELECT content FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.client_phone = $1 AND m.direction = 'outbound'`,
    [PHONE]
  );
  assert.ok(msgs.rows.some((r) => /Recordatorio enviado/.test(r.content)));

  // Segunda pasada: ya no reenvía esta cita.
  const sender2 = fakeTemplateSender();
  await reminderService.runOnce({ sendTemplateMessage: sender2.fn });
  assert.ok(!sender2.calls.some((c) => c.to === PHONE), 'no debe reenviar un recordatorio ya enviado');
});

test('no envía recordatorio de citas a más de 24h', async () => {
  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, 'remclient2', 'Lejana', now() + interval '3 days', now() + interval '3 days', 'confirmed')`,
    [BUSINESS_ID, MANICURE_ID]
  );
  const sender = fakeTemplateSender();
  await reminderService.runOnce({ sendTemplateMessage: sender.fn });
  assert.ok(!sender.calls.some((c) => c.to === 'remclient2'), 'una cita a 3 días no debe recordarse aún');
});

test('no llama "mañana" a una cita del mismo día', async () => {
  const now = DateTime.now().setZone(TZ);
  const startsAt = now.endOf('day').minus({ minutes: 1 });
  if (startsAt <= now) return; // borde excepcional del último minuto del día

  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, 'remclient3', 'Mismo día', $3, $4, 'confirmed')`,
    [BUSINESS_ID, MANICURE_ID, startsAt.toISO(), startsAt.plus({ minutes: 45 }).toISO()]
  );
  const sender = fakeTemplateSender();
  await reminderService.runOnce({ sendTemplateMessage: sender.fn });
  assert.ok(!sender.calls.some((c) => c.to === 'remclient3'), 'la plantilla "mañana" no aplica el mismo día');
});
