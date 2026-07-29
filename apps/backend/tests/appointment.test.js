const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
const appointmentService = require('../src/services/appointmentService');

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111'; // demo
const MANICURE_ID = '22222222-2222-2222-2222-222222222201'; // 45 min, del seed
const TZ = 'America/Mexico_City';
const PHONE = 'apptclient1';

// Fecha futura (dentro de la ventana) que no caiga en domingo.
function futureWeekday() {
  let d = DateTime.now().setZone(TZ).plus({ days: 10 }).startOf('day');
  if (d.weekday === 7) d = d.plus({ days: 1 }); // 7 = domingo en luxon
  return d;
}

async function cleanup() {
  await db.query(`DELETE FROM appointments WHERE client_phone LIKE 'apptclient%'`);
}

before(cleanup);
after(async () => {
  await cleanup();
  await db.pool.end();
});

test('getAvailability devuelve hasta 6 slots empezando a las 10:00 en día hábil', async () => {
  const date = futureWeekday().toFormat('yyyy-MM-dd');
  const res = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  assert.ok(!res.error, `error inesperado: ${res.error}`);
  assert.strictEqual(res.slots.length, 6);
  const first = DateTime.fromISO(res.slots[0].datetime_iso, { zone: TZ });
  assert.strictEqual(first.hour, 10);
  assert.strictEqual(first.minute, 0);
});

test('domingo aparece como cerrado (sin slots)', async () => {
  let sun = DateTime.now().setZone(TZ).plus({ days: 1 }).startOf('day');
  while (sun.weekday !== 7) sun = sun.plus({ days: 1 });
  const res = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date: sun.toFormat('yyyy-MM-dd'), serviceId: MANICURE_ID, timezone: TZ,
  });
  assert.strictEqual(res.closed, true);
  assert.strictEqual(res.slots.length, 0);
});

test('crear una cita ocupa el slot y ya no se ofrece (sin empalmes)', async () => {
  const date = futureWeekday().toFormat('yyyy-MM-dd');
  const before = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  const slotIso = before.slots[0].datetime_iso; // 10:00

  const created = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: PHONE, serviceId: MANICURE_ID,
    datetimeIso: slotIso, clientName: 'Ana', timezone: TZ,
  });
  assert.ok(created.id, `no se creó la cita: ${created.error}`);

  const afterBook = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  const newFirst = DateTime.fromISO(afterBook.slots[0].datetime_iso, { zone: TZ });
  // El primer slot ya no es 10:00 sino 10:45 (duración 45 min).
  assert.strictEqual(newFirst.minute, 45);

  // Intentar reservar el mismo slot vuelve a fallar (condición de carrera / doble reserva).
  const conflict = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: 'apptclient2', serviceId: MANICURE_ID,
    datetimeIso: slotIso, clientName: 'Otra', timezone: TZ,
  });
  assert.strictEqual(conflict.error, 'slot_ocupado');

  // Cancelar libera el slot de nuevo.
  const cancelled = await appointmentService.cancelAppointment({
    businessId: BUSINESS_ID, clientPhone: PHONE, appointmentId: created.id,
  });
  assert.strictEqual(cancelled.id, created.id);

  const afterCancel = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  const freed = DateTime.fromISO(afterCancel.slots[0].datetime_iso, { zone: TZ });
  assert.strictEqual(freed.hour, 10);
  assert.strictEqual(freed.minute, 0);
});

test('no se puede cancelar la cita de otro cliente (aislamiento)', async () => {
  const res = await appointmentService.cancelAppointment({
    businessId: BUSINESS_ID, clientPhone: 'otro-telefono', appointmentId: '00000000-0000-0000-0000-000000000000',
  });
  assert.strictEqual(res.error, 'cita_no_encontrada');
});
