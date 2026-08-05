// Pruebas del backend del panel web (Fase 5): auth (JWT + revocación), autorización por rol,
// aislamiento multi-tenant, CRUD de servicios/horarios/config y API de super-admin.
process.env.WHATSAPP_MODE = 'mock';
process.env.AI_MODE = 'mock';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-para-pruebas';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const request = require('supertest');
const { createApp } = require('../src/app');
const db = require('../src/config/db');
const authService = require('../src/services/authService');
const whatsappService = require('../src/services/whatsappService');

const app = createApp();
const TZ = 'America/Mexico_City';
const BIZ_P = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BIZ_Q = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SVC_P = 'cccccccc-cccc-cccc-cccc-ccccccccc001';
const SVC_Q = 'dddddddd-dddd-dddd-dddd-ddddddddd001';
const USER_OWNER_P = 'cccccccc-cccc-cccc-cccc-cccccccc0001';
const USER_OWNER_Q = 'dddddddd-dddd-dddd-dddd-dddddddd0001';
const USER_SUPER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001';

let tokenOwnerP, tokenOwnerQ, tokenSuper;

async function cleanup() {
  const { rows } = await db.query(
    `SELECT id FROM businesses WHERE wa_phone LIKE '+52TEST%' OR wa_phone = '+525550000099'`
  );
  for (const b of rows) {
    await db.query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE business_id = $1)`, [b.id]);
    await db.query('DELETE FROM conversations WHERE business_id = $1', [b.id]);
    await db.query('DELETE FROM appointments WHERE business_id = $1', [b.id]);
    await db.query('DELETE FROM blocks WHERE business_id = $1', [b.id]);
    await db.query('DELETE FROM schedules WHERE business_id = $1', [b.id]);
    await db.query('DELETE FROM services WHERE business_id = $1', [b.id]);
  }
  await db.query(`DELETE FROM users WHERE email LIKE '%@paneltest.com'`);
  await db.query(`DELETE FROM businesses WHERE wa_phone LIKE '+52TEST%' OR wa_phone = '+525550000099'`);
}

before(async () => {
  await cleanup();
  const hashP = await authService.hashPassword('secretP');
  const hashQ = await authService.hashPassword('secretQ');
  const hashS = await authService.hashPassword('superpass');

  for (const [id, svc, phone, days] of [[BIZ_P, SVC_P, '+52TESTP', 30], [BIZ_Q, SVC_Q, '+52TESTQ', 30]]) {
    await db.query(
      `INSERT INTO businesses (id, name, wa_phone, timezone, is_active, subscription_expiry)
       VALUES ($1, $2, $3, $4, true, now() + ($5 || ' days')::interval)`,
      [id, 'Negocio ' + phone, phone, TZ, String(days)]
    );
    await db.query(
      `INSERT INTO services (id, business_id, name, price, duration_minutes) VALUES ($1, $2, 'Servicio', 100, 60)`,
      [svc, id]
    );
    for (let d = 0; d < 7; d++) {
      await db.query(`INSERT INTO schedules (business_id, day_of_week, start_time, end_time) VALUES ($1, $2, '10:00', '19:00')`, [id, d]);
    }
  }
  await db.query(
    `INSERT INTO users (id, business_id, email, password_hash, role) VALUES
       ($1, $2, 'ownerp@paneltest.com', $3, 'owner'),
       ($4, $5, 'ownerq@paneltest.com', $6, 'owner'),
       ($7, NULL, 'super@paneltest.com', $8, 'superadmin')`,
    [USER_OWNER_P, BIZ_P, hashP, USER_OWNER_Q, BIZ_Q, hashQ, USER_SUPER, hashS]
  );
});

after(async () => {
  await cleanup();
  await db.pool.end();
});

async function login(email, password) {
  const res = await request(app).post('/auth/login').send({ email, password });
  return res;
}

// --- 5.1 Auth ---
test('login con credenciales correctas devuelve token y usuario', async () => {
  const res = await login('ownerp@paneltest.com', 'secretP');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.user.role, 'owner');
  tokenOwnerP = res.body.token;

  tokenOwnerQ = (await login('ownerq@paneltest.com', 'secretQ')).body.token;
  tokenSuper = (await login('super@paneltest.com', 'superpass')).body.token;
  assert.ok(tokenOwnerQ && tokenSuper);
});

test('login con contraseña incorrecta devuelve 401', async () => {
  const res = await login('ownerp@paneltest.com', 'malapass');
  assert.strictEqual(res.status, 401);
});

test('login sin campos devuelve 400', async () => {
  const res = await request(app).post('/auth/login').send({ email: 'x@x.com' });
  assert.strictEqual(res.status, 400);
});

test('login bloquea temporalmente después de demasiados intentos fallidos', async () => {
  const email = 'ataque@paneltest.com';
  for (let i = 0; i < 10; i++) {
    const failed = await login(email, 'incorrecta');
    assert.strictEqual(failed.status, 401);
  }
  const blocked = await login(email, 'incorrecta');
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
});

test('login bloquea por correo aunque Railway cambie la IP del proxy en cada intento', async () => {
  const email = 'proxy-variable@paneltest.com';
  for (let i = 0; i < 10; i++) {
    const failed = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', `203.0.113.${i + 1}`)
      .send({ email, password: 'incorrecta' });
    assert.strictEqual(failed.status, 401);
  }

  const blocked = await request(app)
    .post('/auth/login')
    .set('X-Forwarded-For', '198.51.100.200')
    .send({ email, password: 'incorrecta' });
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
});

test('ruta protegida sin token devuelve 401', async () => {
  const res = await request(app).get('/panel/services');
  assert.strictEqual(res.status, 401);
});

test('ruta protegida con token inválido devuelve 401', async () => {
  const res = await request(app).get('/panel/services').set('Authorization', 'Bearer basura');
  assert.strictEqual(res.status, 401);
});

// --- 5.1 Autorización por rol ---
test('un owner no puede acceder a rutas de super-admin (403)', async () => {
  const res = await request(app).get('/admin/businesses').set('Authorization', `Bearer ${tokenOwnerP}`);
  assert.strictEqual(res.status, 403);
});

test('un super-admin no puede acceder a rutas del panel de dueña (403)', async () => {
  const res = await request(app).get('/panel/services').set('Authorization', `Bearer ${tokenSuper}`);
  assert.strictEqual(res.status, 403);
});

// --- 5.2 Aislamiento multi-tenant ---
test('la dueña de P solo ve sus propios servicios, no los de Q', async () => {
  const res = await request(app).get('/panel/services').set('Authorization', `Bearer ${tokenOwnerP}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.services.every((s) => s.id !== SVC_Q), 'no debe aparecer un servicio de Q');
  assert.ok(res.body.services.some((s) => s.id === SVC_P));
});

// --- 5.2 CRUD de servicios ---
test('crear, actualizar y desactivar un servicio', async () => {
  const created = await request(app).post('/panel/services')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ name: 'Diseño de cejas', price: 180, duration_minutes: 30 });
  assert.strictEqual(created.status, 201);
  const id = created.body.service.id;

  const updated = await request(app).patch(`/panel/services/${id}`)
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ price: 200 });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(Number(updated.body.service.price), 200);

  const del = await request(app).delete(`/panel/services/${id}`).set('Authorization', `Bearer ${tokenOwnerP}`);
  assert.strictEqual(del.status, 200);
});

test('rechaza servicios con precio o duración inválidos', async () => {
  const negative = await request(app).post('/panel/services')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ name: 'Inválido', price: -10, duration_minutes: -5 });
  assert.strictEqual(negative.status, 400);

  const zeroDuration = await request(app).post('/panel/services')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ name: 'Inválido', price: 10, duration_minutes: 0 });
  assert.strictEqual(zeroDuration.status, 400);
});

// --- 5.2 CRUD de horarios ---
test('crear y eliminar un horario', async () => {
  const created = await request(app).post('/panel/schedules')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ day_of_week: 0, start_time: '11:00', end_time: '15:00' });
  assert.strictEqual(created.status, 201);
  const del = await request(app).delete(`/panel/schedules/${created.body.schedule.id}`)
    .set('Authorization', `Bearer ${tokenOwnerP}`);
  assert.strictEqual(del.status, 200);
});

test('rechaza un horario exactamente duplicado', async () => {
  const duplicate = await request(app).post('/panel/schedules')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ day_of_week: 1, start_time: '10:00', end_time: '19:00' });
  assert.strictEqual(duplicate.status, 409);
  assert.strictEqual(duplicate.body.error, 'Ese horario ya existe');
});

test('rechaza horarios invertidos o con formato inválido', async () => {
  const inverted = await request(app).post('/panel/schedules')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ day_of_week: 2, start_time: '19:00', end_time: '10:00' });
  assert.strictEqual(inverted.status, 400);

  const malformed = await request(app).post('/panel/schedules')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ day_of_week: 2, start_time: '99:00', end_time: '10:00' });
  assert.strictEqual(malformed.status, 400);
});

// --- 5.2 Config del negocio ---
test('actualizar la configuración del bot y el owner_phone', async () => {
  const res = await request(app).patch('/panel/business')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ bot_name: 'Sofía', owner_phone: '+525550001111' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.business.bot_name, 'Sofía');
  assert.strictEqual(res.body.business.owner_phone, '+525550001111');
});

test('rechaza teléfono y zona horaria inválidos en la configuración', async () => {
  const phone = await request(app).patch('/panel/business')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ owner_phone: '555-no-e164' });
  assert.strictEqual(phone.status, 400);

  const timezone = await request(app).patch('/panel/business')
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ timezone: 'Zona/Inventada' });
  assert.strictEqual(timezone.status, 400);
});

// --- 5.2 Citas: listar, cambiar estado, reprogramar (dispara plantilla) ---
test('listar citas, cambiar estado y reprogramar con aviso de plantilla', async () => {
  const date = DateTime.now().setZone(TZ).plus({ days: 6 }).toFormat('yyyy-LL-dd');
  const start = DateTime.fromISO(date + 'T11:00', { zone: TZ });
  const appt = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, '5215550000010', 'Ana', $3, $4, 'confirmed') RETURNING id`,
    [BIZ_P, SVC_P, start.toISO(), start.plus({ minutes: 60 }).toISO()]
  );
  const apptId = appt.rows[0].id;

  const list = await request(app).get(`/panel/appointments?from=${date}&to=${date}`)
    .set('Authorization', `Bearer ${tokenOwnerP}`);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.appointments.some((a) => a.id === apptId));

  // Reprogramar a las 16:00 del mismo día → debe avisar con plantilla.
  whatsappService.sentTemplatesInMock.length = 0;
  const newStart = DateTime.fromISO(date + 'T16:00', { zone: TZ });
  const resched = await request(app).patch(`/panel/appointments/${apptId}`)
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ starts_at: newStart.toISO() });
  assert.strictEqual(resched.status, 200);
  assert.strictEqual(whatsappService.sentTemplatesInMock.length, 1);

  // Cambiar estado a completed.
  const st = await request(app).patch(`/panel/appointments/${apptId}`)
    .set('Authorization', `Bearer ${tokenOwnerP}`)
    .send({ status: 'completed' });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.body.cita.status, 'completed');
});

// --- 5.3 Super-admin ---
test('super-admin lista negocios, da de alta uno nuevo y controla la suscripción', async () => {
  const list = await request(app).get('/admin/businesses').set('Authorization', `Bearer ${tokenSuper}`);
  assert.strictEqual(list.status, 200);
  assert.ok(Array.isArray(list.body.businesses));

  // Alta de negocio + owner.
  const created = await request(app).post('/admin/businesses')
    .set('Authorization', `Bearer ${tokenSuper}`)
    .send({
      name: 'Nuevo Salón',
      wa_phone: '+525550000099',
      ownerEmail: 'nuevo@paneltest.com',
      ownerPassword: 'nuevopass-segura-2026',
    });
  assert.strictEqual(created.status, 201);
  const newBizId = created.body.business.id;

  // El nuevo owner puede iniciar sesión.
  const loginNew = await login('nuevo@paneltest.com', 'nuevopass-segura-2026');
  assert.strictEqual(loginNew.status, 200);

  // Vencer la suscripción del nuevo negocio.
  const patched = await request(app).patch(`/admin/businesses/${newBizId}`)
    .set('Authorization', `Bearer ${tokenSuper}`)
    .send({ subscription_expiry: new Date(Date.now() - 86400000).toISOString() });
  assert.strictEqual(patched.status, 200);
});

test('revocar tokens invalida las sesiones existentes del usuario', async () => {
  // El owner de Q tiene un token válido; tras revocar, deja de funcionar.
  const before = await request(app).get('/panel/services').set('Authorization', `Bearer ${tokenOwnerQ}`);
  assert.strictEqual(before.status, 200);

  const revoke = await request(app).post(`/admin/users/${USER_OWNER_Q}/revoke-tokens`)
    .set('Authorization', `Bearer ${tokenSuper}`);
  assert.strictEqual(revoke.status, 200);

  const after = await request(app).get('/panel/services').set('Authorization', `Bearer ${tokenOwnerQ}`);
  assert.strictEqual(after.status, 401, 'el token viejo debe quedar invalidado');
});
