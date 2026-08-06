// Pruebas del MODO ADMIN (Fase 4): detección de la dueña, aislamiento multi-tenant,
// cancelación con aviso, reprogramación y bloqueos de horario.
process.env.WHATSAPP_MODE = 'mock';
process.env.AI_MODE = 'mock';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
const whatsappService = require('../src/services/whatsappService');
const appointmentService = require('../src/services/appointmentService');
const adminTools = require('../src/tools/adminTools');
const { processInboundMessage, isOwner } = require('../src/services/messageHandler');

const TZ = 'America/Mexico_City';
// Dos negocios de prueba para verificar el aislamiento multi-tenant.
const BIZ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SVC_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001';
const SVC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb001';
const OWNER_A = '5214000000001'; // wa_id estilo México (con "1" extra)

const businessA = {
  id: BIZ_A, name: 'Negocio A', wa_phone_number_id: 'PNID_A', owner_phone: '+52 400 000 0001',
  timezone: TZ, is_active: true, subscription_expiry: new Date(Date.now() + 86400000),
};

async function cleanup() {
  for (const id of [BIZ_A, BIZ_B]) {
    await db.query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE business_id = $1)`, [id]);
    await db.query('DELETE FROM conversations WHERE business_id = $1', [id]);
    await db.query('DELETE FROM appointments WHERE business_id = $1', [id]);
    await db.query('DELETE FROM blocks WHERE business_id = $1', [id]);
    await db.query('DELETE FROM schedules WHERE business_id = $1', [id]);
    await db.query('DELETE FROM services WHERE business_id = $1', [id]);
    await db.query('DELETE FROM businesses WHERE id = $1', [id]);
  }
}

// Devuelve una fecha (YYYY-MM-DD) N días en el futuro, en la zona del negocio.
function futureDate(days) {
  return DateTime.now().setZone(TZ).plus({ days }).toFormat('yyyy-LL-dd');
}

before(async () => {
  await cleanup();
  // Negocio A y B con horario todos los días 10:00–19:00 y un servicio de 60 min.
  for (const [id, svc, pnid, owner] of [[BIZ_A, SVC_A, 'PNID_A', '+524000000001'], [BIZ_B, SVC_B, 'PNID_B', '+524000000002']]) {
    await db.query(
      `INSERT INTO businesses (id, name, wa_phone, wa_phone_number_id, owner_phone, timezone, is_active, subscription_expiry)
       VALUES ($1, $2, $3, $4, $5, $6, true, now() + interval '30 days')`,
      [id, 'Negocio ' + id.slice(0, 4), '+52999' + id.slice(0, 6), pnid, owner, TZ]
    );
    await db.query(
      `INSERT INTO services (id, business_id, name, price, duration_minutes) VALUES ($1, $2, 'Servicio', 100, 60)`,
      [svc, id]
    );
    for (let d = 0; d < 7; d++) {
      await db.query(
        `INSERT INTO schedules (business_id, day_of_week, start_time, end_time) VALUES ($1, $2, '10:00', '19:00')`,
        [id, d]
      );
    }
  }
});

beforeEach(() => {
  whatsappService.sentInMock.length = 0;
  whatsappService.sentTemplatesInMock.length = 0;
});

after(async () => {
  await cleanup();
  await db.pool.end();
});

// --- 4.1 Detección de la dueña ---
test('isOwner reconoce a la dueña normalizando el "1" extra de México', () => {
  assert.strictEqual(isOwner(businessA, OWNER_A), true, 'el wa_id 521... debe reconocerse como la dueña');
  assert.strictEqual(isOwner(businessA, '524000000009'), false, 'otro número no es la dueña');
  assert.strictEqual(isOwner({ ...businessA, owner_phone: null }, OWNER_A), false, 'sin owner_phone, nadie es dueña');
});

test('un mensaje de la dueña entra al flujo admin (isAdmin=true); el de una clienta no', async () => {
  const conv = await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
    [BIZ_A, OWNER_A]
  );
  const captured = [];
  const fakeGenerate = async (args) => { captured.push(args.isAdmin); return 'ok'; };

  await processInboundMessage({ business: businessA, from: OWNER_A, conversationId: conv.rows[0].id }, { generateReply: fakeGenerate });

  const convC = await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1, 'clientaX', 'whatsapp') RETURNING id`,
    [BIZ_A]
  );
  await processInboundMessage({ business: businessA, from: 'clientaX', conversationId: convC.rows[0].id }, { generateReply: fakeGenerate });

  assert.deepStrictEqual(captured, [true, false]);
});

// --- 4.4 Aislamiento multi-tenant ---
test('la dueña de A no ve las citas de B (aislamiento por business_id)', async () => {
  // Cita para B mañana a las 11:00.
  const when = DateTime.fromISO(futureDate(1) + 'T11:00', { zone: TZ });
  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, 'clienteB', 'Cliente B', $3, $4, 'confirmed')`,
    [BIZ_B, SVC_B, when.toISO(), when.plus({ minutes: 60 }).toISO()]
  );

  const res = await appointmentService.getAppointmentsByDate({ businessId: BIZ_A, date: futureDate(1), timezone: TZ });
  assert.strictEqual(res.appointments.length, 0, 'A no debe ver citas de B');
});

test('la dueña de A no puede cancelar una cita de B', async () => {
  const when = DateTime.fromISO(futureDate(2) + 'T12:00', { zone: TZ });
  const appt = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, starts_at, ends_at, status)
     VALUES ($1, $2, 'clienteB', $3, $4, 'confirmed') RETURNING id`,
    [BIZ_B, SVC_B, when.toISO(), when.plus({ minutes: 60 }).toISO()]
  );
  const res = await appointmentService.cancelAppointmentAdmin({ businessId: BIZ_A, appointmentId: appt.rows[0].id });
  assert.strictEqual(res.error, 'cita_no_encontrada');

  // La cita de B sigue confirmada.
  const check = await db.query('SELECT status FROM appointments WHERE id = $1', [appt.rows[0].id]);
  assert.strictEqual(check.rows[0].status, 'confirmed');
});

// --- 4.3 Cancelación por la dueña avisa a la clienta ---
test('cancel_appointment_admin cancela y avisa a la clienta afectada', async () => {
  const when = DateTime.fromISO(futureDate(3) + 'T13:00', { zone: TZ });
  const clientPhone = '5215550000003';
  const appt = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $5, 'Rosa', $3, $4, 'confirmed') RETURNING id`,
    [BIZ_A, SVC_A, when.toISO(), when.plus({ minutes: 60 }).toISO(), clientPhone]
  );

  const out = await adminTools.execute('cancel_appointment_admin', { appointment_id: appt.rows[0].id }, { business: businessA });
  assert.match(out, /"ok":true/);

  const check = await db.query('SELECT status FROM appointments WHERE id = $1', [appt.rows[0].id]);
  assert.strictEqual(check.rows[0].status, 'cancelled');
  assert.strictEqual(whatsappService.sentInMock.length, 1, 'la clienta debe recibir el aviso');
  assert.strictEqual(whatsappService.sentInMock[0].to, whatsappService.normalizeRecipient(clientPhone));
});

// --- 4.3 Reprogramación por la dueña ---
test('reschedule_appointment_admin mueve la cita y avisa con plantilla', async () => {
  const when = DateTime.fromISO(futureDate(4) + 'T14:00', { zone: TZ });
  const appt = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, 'clientaRe', 'Luz', $3, $4, 'confirmed') RETURNING id`,
    [BIZ_A, SVC_A, when.toISO(), when.plus({ minutes: 60 }).toISO()]
  );
  const newWhen = DateTime.fromISO(futureDate(4) + 'T16:00', { zone: TZ });

  const out = await adminTools.execute(
    'reschedule_appointment_admin',
    { appointment_id: appt.rows[0].id, new_datetime: newWhen.toISO() },
    { business: businessA }
  );
  assert.match(out, /"ok":true/);

  const check = await db.query('SELECT status, starts_at FROM appointments WHERE id = $1', [appt.rows[0].id]);
  assert.strictEqual(check.rows[0].status, 'rescheduled');
  assert.strictEqual(whatsappService.sentTemplatesInMock.length, 1);
  assert.strictEqual(whatsappService.sentTemplatesInMock[0].templateName, adminTools.RESCHEDULE_TEMPLATE);
});

// --- 4.3 / 4.4 Bloqueo de horario respetado por check_availability ---
test('block_time_slot hace que ese rango deje de ofrecerse a las clientas', async () => {
  const date = futureDate(5);
  // Antes del bloqueo: las 10:00 están disponibles.
  const before = await appointmentService.getAvailability({ businessId: BIZ_A, date, serviceId: SVC_A, timezone: TZ });
  const had10 = before.slots.some((s) => s.datetime_iso.includes('T10:00'));
  assert.ok(had10, 'las 10:00 deberían estar libres antes del bloqueo');

  const blk = await adminTools.execute(
    'block_time_slot',
    { date, start_time: '10:00', end_time: '12:00', reason: 'descanso' },
    { business: businessA }
  );
  assert.match(blk, /"ok":true/);

  const after = await appointmentService.getAvailability({ businessId: BIZ_A, date, serviceId: SVC_A, timezone: TZ });
  const has10or11 = after.slots.some((s) => s.datetime_iso.includes('T10:00') || s.datetime_iso.includes('T11:00'));
  assert.strictEqual(has10or11, false, '10:00 y 11:00 deben desaparecer por el bloqueo');
});

// --- 4.3 Resumen de la semana ---
test('get_week_summary devuelve total y desgloses', async () => {
  const out = await adminTools.execute('get_week_summary', {}, { business: businessA });
  const parsed = JSON.parse(out);
  const expectedStart = DateTime.now().setZone(TZ).startOf('week');
  assert.ok(typeof parsed.total === 'number');
  assert.ok(parsed.por_dia && typeof parsed.por_dia === 'object');
  assert.ok(parsed.por_estado && typeof parsed.por_estado === 'object');
  assert.strictEqual(parsed.semana_desde, expectedStart.toFormat('yyyy-LL-dd'));
  assert.strictEqual(parsed.semana_hasta, expectedStart.plus({ days: 6 }).toFormat('yyyy-LL-dd'));
});
