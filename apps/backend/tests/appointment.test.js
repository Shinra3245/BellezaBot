const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
const appointmentService = require('../src/services/appointmentService');

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111'; // demo
const MANICURE_ID = '22222222-2222-2222-2222-222222222201'; // 45 min, del seed
const PEDICURE_ID = '22222222-2222-2222-2222-222222222202'; // 60 min
const ACRYLIC_ID = '22222222-2222-2222-2222-222222222203'; // 90 min
const THIRTY_MINUTE_ID = '22222222-2222-2222-2222-222222222230';
const TZ = 'America/Mexico_City';
const PHONE = 'apptclient1';

// Fecha futura (dentro de la ventana) que no caiga en domingo.
function futureOpenDay(days = 10) {
  let d = DateTime.now().setZone(TZ).plus({ days }).startOf('day');
  if (d.weekday === 7) d = d.plus({ days: 1 }); // 7 = domingo en luxon
  return d;
}

function futureWeekday() {
  return futureOpenDay(10);
}

async function cleanup() {
  await db.query(`DELETE FROM appointments WHERE client_phone LIKE 'apptclient%'`);
  await db.query(`DELETE FROM blocks WHERE reason LIKE 'appttest%'`);
  await db.query('DELETE FROM services WHERE id = $1', [THIRTY_MINUTE_ID]);
}

before(cleanup);
after(async () => {
  await cleanup();
  await db.pool.end();
});

test('getAvailability distribuye 6 opciones e incluye apertura y último horario válido', async () => {
  const date = futureWeekday().toFormat('yyyy-MM-dd');
  const res = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  assert.ok(!res.error, `error inesperado: ${res.error}`);
  assert.strictEqual(res.slots.length, 6);
  const first = DateTime.fromISO(res.slots[0].datetime_iso, { zone: TZ });
  assert.strictEqual(first.hour, 10);
  assert.strictEqual(first.minute, 0);
  const last = DateTime.fromISO(res.slots.at(-1).datetime_iso, { zone: TZ });
  assert.strictEqual(last.hour, 18);
  assert.strictEqual(last.minute, 15);
});

test('getAvailability valida una hora exacta de la tarde sin ocultarla por el límite de opciones', async () => {
  const date = futureOpenDay(12).toFormat('yyyy-MM-dd');
  const available = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ, preferredTime: '18:15',
  });
  assert.strictEqual(available.slots.length, 1);
  assert.match(available.slots[0].datetime_iso, /T18:15/);

  const tooLate = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ, preferredTime: '18:30',
  });
  assert.deepStrictEqual(tooLate.slots, []);

  const invalid = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ, preferredTime: '25:00',
  });
  assert.strictEqual(invalid.error, 'hora_invalida');
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

test('una fecha pasada se identifica explícitamente y no se reporta como falta de disponibilidad', async () => {
  const date = DateTime.now().setZone(TZ).minus({ days: 1 }).toFormat('yyyy-MM-dd');
  const res = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  assert.strictEqual(res.past, true);
  assert.deepStrictEqual(res.slots, []);
  assert.strictEqual(res.closed, undefined);
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

test('la creación final rechaza horas fuera del horario y horas no alineadas', async () => {
  const date = futureWeekday().toFormat('yyyy-MM-dd');
  const outside = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: 'apptclient3', serviceId: MANICURE_ID,
    datetimeIso: `${date}T09:00:00`, clientName: 'Fuera', timezone: TZ,
  });
  assert.strictEqual(outside.error, 'fuera_de_horario');

  const unaligned = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: 'apptclient3', serviceId: MANICURE_ID,
    datetimeIso: `${date}T10:15:00`, clientName: 'Desalineada', timezone: TZ,
  });
  assert.strictEqual(unaligned.error, 'fuera_de_horario');
});

test('la creación final rechaza fechas posteriores a 30 días', async () => {
  const date = DateTime.now().setZone(TZ).plus({ days: 31 }).toFormat('yyyy-MM-dd');
  const result = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: 'apptclient4', serviceId: MANICURE_ID,
    datetimeIso: `${date}T10:00:00`, clientName: 'Lejana', timezone: TZ,
  });
  assert.strictEqual(result.error, 'fecha_fuera_de_ventana');
});

test('la creación final rechaza un slot bloqueado aunque la IA intente reservarlo', async () => {
  const date = futureWeekday().toFormat('yyyy-MM-dd');
  const block = await appointmentService.createBlock({
    businessId: BUSINESS_ID, date, startTime: '10:00', endTime: '10:45',
    reason: 'appttest-block', timezone: TZ,
  });
  assert.ok(block.id);

  const result = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: 'apptclient5', serviceId: MANICURE_ID,
    datetimeIso: `${date}T10:00:00`, clientName: 'Bloqueada', timezone: TZ,
  });
  assert.strictEqual(result.error, 'slot_bloqueado');
});

test('una clienta puede listar y reprogramar su propia cita, pero no la de otra clienta', async () => {
  const date = futureWeekday().toFormat('yyyy-MM-dd');
  const availability = await appointmentService.getAvailability({
    businessId: BUSINESS_ID, date, serviceId: MANICURE_ID, timezone: TZ,
  });
  const first = availability.slots[0].datetime_iso;
  const second = availability.slots[1].datetime_iso;
  const created = await appointmentService.createAppointment({
    businessId: BUSINESS_ID, clientPhone: 'apptclient6', serviceId: MANICURE_ID,
    datetimeIso: first, clientName: 'Elena', timezone: TZ,
  });
  assert.ok(created.id);

  const mine = await appointmentService.getUpcomingAppointments({
    businessId: BUSINESS_ID, clientPhone: 'apptclient6', timezone: TZ,
  });
  assert.ok(mine.some((appointment) => appointment.id === created.id));

  const denied = await appointmentService.rescheduleAppointmentClient({
    businessId: BUSINESS_ID, clientPhone: 'otra-clienta', appointmentId: created.id,
    newDatetimeIso: second, timezone: TZ,
  });
  assert.strictEqual(denied.error, 'cita_no_encontrada');

  const moved = await appointmentService.rescheduleAppointmentClient({
    businessId: BUSINESS_ID, clientPhone: 'apptclient6', appointmentId: created.id,
    newDatetimeIso: second, timezone: TZ,
  });
  assert.strictEqual(moved.id, created.id);
});

test('cada servicio respeta su último inicio válido y rechaza terminar después de las 19:00', async () => {
  const cases = [
    { serviceId: MANICURE_ID, valid: '18:15', invalid: '18:30', phone: 'apptclient-close-45' },
    { serviceId: PEDICURE_ID, valid: '18:00', invalid: '18:15', phone: 'apptclient-close-60' },
    { serviceId: ACRYLIC_ID, valid: '17:30', invalid: '18:00', phone: 'apptclient-close-90' },
  ];

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const date = futureOpenDay(18 + i).toFormat('yyyy-MM-dd');
    const valid = await appointmentService.createAppointment({
      businessId: BUSINESS_ID,
      clientPhone: testCase.phone,
      serviceId: testCase.serviceId,
      datetimeIso: `${date}T${testCase.valid}:00`,
      clientName: 'Límite válido',
      timezone: TZ,
    });
    assert.ok(valid.id, `el inicio ${testCase.valid} debe caber: ${valid.error}`);

    const invalid = await appointmentService.createAppointment({
      businessId: BUSINESS_ID,
      clientPhone: `${testCase.phone}-late`,
      serviceId: testCase.serviceId,
      datetimeIso: `${date}T${testCase.invalid}:00`,
      clientName: 'Fuera de cierre',
      timezone: TZ,
    });
    assert.strictEqual(invalid.error, 'fuera_de_horario');
  }
});

test('una cita bloquea cualquier servicio que se empalme, aunque tenga otra duración', async () => {
  const date = futureOpenDay(22).toFormat('yyyy-MM-dd');
  const manicure = await appointmentService.createAppointment({
    businessId: BUSINESS_ID,
    clientPhone: 'apptclient-cross-manicure',
    serviceId: MANICURE_ID,
    datetimeIso: `${date}T18:15:00`,
    clientName: 'Manicure tarde',
    timezone: TZ,
  });
  assert.ok(manicure.id);

  const pedicure = await appointmentService.createAppointment({
    businessId: BUSINESS_ID,
    clientPhone: 'apptclient-cross-pedicure',
    serviceId: PEDICURE_ID,
    datetimeIso: `${date}T18:00:00`,
    clientName: 'Pedicure empalmado',
    timezone: TZ,
  });
  assert.strictEqual(pedicure.error, 'slot_ocupado');

  const acrylic = await appointmentService.createAppointment({
    businessId: BUSINESS_ID,
    clientPhone: 'apptclient-cross-acrylic',
    serviceId: ACRYLIC_ID,
    datetimeIso: `${date}T17:30:00`,
    clientName: 'Acrílico empalmado',
    timezone: TZ,
  });
  assert.strictEqual(acrylic.error, 'slot_ocupado');
});

test('permite citas consecutivas en el límite exacto y solo si la duración cabe antes del cierre', async () => {
  await db.query(
    `INSERT INTO services (id, business_id, name, price, duration_minutes, is_active)
     VALUES ($1, $2, 'Servicio de 30 minutos', 100, 30, true)`,
    [THIRTY_MINUTE_ID, BUSINESS_ID]
  );
  const date = futureOpenDay(24).toFormat('yyyy-MM-dd');

  const first = await appointmentService.createAppointment({
    businessId: BUSINESS_ID,
    clientPhone: 'apptclient-adjacent-first',
    serviceId: THIRTY_MINUTE_ID,
    datetimeIso: `${date}T18:00:00`,
    clientName: 'Primera media hora',
    timezone: TZ,
  });
  assert.ok(first.id);

  const manicureTooLong = await appointmentService.createAppointment({
    businessId: BUSINESS_ID,
    clientPhone: 'apptclient-adjacent-too-long',
    serviceId: MANICURE_ID,
    datetimeIso: `${date}T18:30:00`,
    clientName: 'No cabe',
    timezone: TZ,
  });
  assert.strictEqual(manicureTooLong.error, 'fuera_de_horario');

  const exactBoundary = await appointmentService.getAvailability({
    businessId: BUSINESS_ID,
    date,
    serviceId: THIRTY_MINUTE_ID,
    timezone: TZ,
    preferredTime: '18:30',
  });
  assert.strictEqual(exactBoundary.slots.length, 1, '18:30 debe quedar libre cuando la anterior termina a esa hora');

  const second = await appointmentService.createAppointment({
    businessId: BUSINESS_ID,
    clientPhone: 'apptclient-adjacent-second',
    serviceId: THIRTY_MINUTE_ID,
    datetimeIso: `${date}T18:30:00`,
    clientName: 'Segunda media hora',
    timezone: TZ,
  });
  assert.ok(second.id, `la cita consecutiva debe caber: ${second.error}`);
});
