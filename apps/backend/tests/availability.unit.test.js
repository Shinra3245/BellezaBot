process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://unit:unit@localhost:5432/bellezabot_test';
process.env.WHATSAPP_MODE = 'mock';
process.env.AI_MODE = 'mock';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
const appointmentService = require('../src/services/appointmentService');

const originalQuery = db.query;
const TZ = 'America/Mexico_City';

after(async () => {
  db.query = originalQuery;
  await db.pool.end();
});

test('genera el dropdown completo sin el horario actual ni horarios ocupados', async () => {
  const date = DateTime.now().setZone(TZ).plus({ days: 2 }).toFormat('yyyy-LL-dd');
  const currentStart = DateTime.fromISO(`${date}T11:00`, { zone: TZ });
  const busyStart = DateTime.fromISO(`${date}T13:00`, { zone: TZ });

  db.query = async (sql) => {
    if (sql.includes('SELECT a.id, a.client_name') && sql.includes('s.duration_minutes')) {
      return {
        rows: [{
          id: 'appointment-1',
          client_name: 'Prueba',
          client_phone: '5215550000000',
          starts_at: currentStart.toJSDate(),
          service_id: 'service-1',
          status: 'confirmed',
          service_name: 'Manicure',
          duration_minutes: 60,
        }],
      };
    }
    if (sql.includes('FROM services')) {
      return { rows: [{ id: 'service-1', name: 'Manicure', price: 250, duration_minutes: 60 }] };
    }
    if (sql.includes('FROM schedules')) {
      return { rows: [{ start_time: '10:00', end_time: '19:00' }] };
    }
    if (sql.includes('FROM appointments') && sql.includes('SELECT starts_at, ends_at')) {
      return {
        rows: [{
          starts_at: busyStart.toJSDate(),
          ends_at: busyStart.plus({ minutes: 60 }).toJSDate(),
        }],
      };
    }
    if (sql.includes('FROM blocks')) return { rows: [] };
    throw new Error(`Consulta no esperada en la prueba: ${sql}`);
  };

  const result = await appointmentService.getRescheduleAvailability({
    businessId: 'business-1',
    appointmentId: 'appointment-1',
    date,
    timezone: TZ,
  });

  const localTimes = result.slots.map((slot) =>
    DateTime.fromISO(slot.datetime_iso).setZone(TZ).toFormat('HH:mm')
  );

  assert.strictEqual(result.duration_minutes, 60);
  assert.ok(result.slots.length > 6, 'debe devolver todos los horarios para el dropdown');
  assert.deepStrictEqual(localTimes, ['10:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
});
