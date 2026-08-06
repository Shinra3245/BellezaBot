// Config de entorno ANTES de cargar la app (env.js lee process.env al requerirse).
process.env.WHATSAPP_MODE = 'mock';
process.env.AI_MODE = 'mock';
process.env.META_VERIFY_TOKEN = 'test-verify-token';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.NODE_ENV = 'test';
process.env.CLIENT_RATE_LIMIT_PER_HOUR = '3';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const db = require('../src/config/db');
const whatsappService = require('../src/services/whatsappService');
const { processInboundMessage, RATE_LIMIT_MESSAGE } = require('../src/services/messageHandler');
const aiService = require('../src/services/aiService');
const { SERVICE_UNAVAILABLE_MESSAGE } = require('../src/services/subscriptionService');

const app = createApp();
const DEMO_BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
let DEMO_PHONE_NUMBER_ID; // se lee de la BD en before() (puede ser el real de Meta)
const settle = () => new Promise((r) => setTimeout(r, 120)); // deja terminar el procesamiento async

// Firma un payload como lo haría Meta y devuelve { raw, signature }.
function signPayload(payload) {
  const raw = JSON.stringify(payload);
  const signature =
    'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
  return { raw, signature };
}

function textMessagePayload({ phoneNumberId, from, waMessageId, text }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
              messages: [{ from, id: waMessageId, timestamp: '1700000000', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

async function cleanupTestData() {
  await db.query(
    `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE client_phone LIKE 'testclient%')`
  );
  await db.query(`DELETE FROM conversations WHERE client_phone LIKE 'testclient%'`);
}

before(async () => {
  await cleanupTestData();
  const { rows } = await db.query('SELECT wa_phone_number_id FROM businesses WHERE id = $1', [DEMO_BUSINESS_ID]);
  DEMO_PHONE_NUMBER_ID = rows[0].wa_phone_number_id;
});
beforeEach(() => {
  whatsappService.sentInMock.length = 0;
});
after(async () => {
  await cleanupTestData();
  await db.pool.end();
});

// --- 1.1 Verificación GET ---
test('GET /webhook con verify_token correcto devuelve el challenge', async () => {
  const res = await request(app)
    .get('/webhook')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '42abc' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, '42abc');
});

test('GET /webhook con verify_token incorrecto devuelve 403', async () => {
  const res = await request(app)
    .get('/webhook')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': '42abc' });
  assert.strictEqual(res.status, 403);
});

// --- 1.2 Firma ---
test('POST /webhook con firma inválida devuelve 401', async () => {
  const { raw } = signPayload(textMessagePayload({
    phoneNumberId: DEMO_PHONE_NUMBER_ID, from: 'testclient1', waMessageId: 'wamid.x', text: 'hola',
  }));
  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', 'sha256=firmafalsa')
    .send(raw);
  assert.strictEqual(res.status, 401);
});

// --- 1.2 Ignorar eventos que no son mensajes de texto ---
test('POST /webhook con evento de status responde 200 y no guarda mensaje', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: DEMO_PHONE_NUMBER_ID },
      statuses: [{ id: 'wamid.s', status: 'delivered' }],
    } }] }],
  };
  const { raw, signature } = signPayload(payload);
  const res = await request(app).post('/webhook')
    .set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(raw);
  assert.strictEqual(res.status, 200);
});

// --- 1.2 Negocio desconocido ---
test('POST /webhook con phone_number_id desconocido responde 200 sin crashear', async () => {
  const { raw, signature } = signPayload(textMessagePayload({
    phoneNumberId: 'NO_EXISTE', from: 'testclient1', waMessageId: 'wamid.unknown', text: 'hola',
  }));
  const res = await request(app).post('/webhook')
    .set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(raw);
  assert.strictEqual(res.status, 200);
});

// --- 1.2 Mensaje válido: se guarda y se procesa ---
test('POST /webhook con mensaje de texto válido responde 200 y guarda el entrante', async () => {
  const waMessageId = 'wamid.valid.' + Date.now();
  const { raw, signature } = signPayload(textMessagePayload({
    phoneNumberId: DEMO_PHONE_NUMBER_ID, from: 'testclient1', waMessageId, text: 'quiero una cita',
  }));
  const res = await request(app).post('/webhook')
    .set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(raw);
  assert.strictEqual(res.status, 200);

  const { rows } = await db.query('SELECT direction, content FROM messages WHERE wa_message_id = $1', [waMessageId]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].direction, 'inbound');
  await settle(); // deja terminar el envío mock async
});

// --- 1.2 Idempotencia ante reintentos de Meta ---
test('POST /webhook con wa_message_id repetido no duplica el mensaje', async () => {
  const waMessageId = 'wamid.dup.' + Date.now();
  const { raw, signature } = signPayload(textMessagePayload({
    phoneNumberId: DEMO_PHONE_NUMBER_ID, from: 'testclient1', waMessageId, text: 'hola',
  }));
  const send = () => request(app).post('/webhook')
    .set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(raw);

  const r1 = await send();
  const r2 = await send();
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r2.status, 200);

  const { rows } = await db.query('SELECT count(*)::int AS n FROM messages WHERE wa_message_id = $1', [waMessageId]);
  assert.strictEqual(rows[0].n, 1);
  await settle();
});

// --- Normalización de número destino (México) ---
test('normalizeRecipient quita el "1" extra de los wa_id de México', () => {
  assert.strictEqual(whatsappService.normalizeRecipient('5214131060699'), '524131060699');
  assert.strictEqual(whatsappService.normalizeRecipient('524131060699'), '524131060699');
  assert.strictEqual(whatsappService.normalizeRecipient('+52 1 413 106 0699'), '524131060699');
  // No toca números de otros países.
  assert.strictEqual(whatsappService.normalizeRecipient('14155550123'), '14155550123');
});

// --- Pipeline (unidad) ---
test('processInboundMessage con suscripción activa envía la respuesta de IA (mock)', async () => {
  const business = {
    id: '11111111-1111-1111-1111-111111111111',
    wa_phone_number_id: DEMO_PHONE_NUMBER_ID,
    is_active: true,
    subscription_expiry: new Date(Date.now() + 86400000),
  };
  // Necesita una conversación real para guardar el outbound.
  const conversationId = (await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1,'testclient9','whatsapp') RETURNING id`,
    [business.id]
  )).rows[0].id;

  await processInboundMessage({ business, from: 'testclient9', text: 'hola', conversationId });
  assert.strictEqual(whatsappService.sentInMock.length, 1);
  assert.strictEqual(whatsappService.sentInMock[0].text, aiService.MOCK_REPLY);
});

test('processInboundMessage con suscripción inactiva envía el mensaje de servicio no disponible', async () => {
  const business = {
    id: '11111111-1111-1111-1111-111111111111',
    wa_phone_number_id: DEMO_PHONE_NUMBER_ID,
    is_active: false,
    subscription_expiry: new Date(Date.now() - 86400000),
  };
  const conversationId = (await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1,'testclient8','whatsapp')
     ON CONFLICT (business_id, client_phone, channel) DO UPDATE SET last_message_at = now() RETURNING id`,
    [business.id]
  )).rows[0].id;

  await processInboundMessage({ business, from: 'testclient8', text: 'hola', conversationId });
  assert.strictEqual(whatsappService.sentInMock.length, 1);
  assert.strictEqual(whatsappService.sentInMock[0].text, SERVICE_UNAVAILABLE_MESSAGE);
});

test('rate limiting configurable: avisa una sola vez y no llama a la IA al superar el límite', async () => {
  const business = {
    id: DEMO_BUSINESS_ID,
    wa_phone_number_id: DEMO_PHONE_NUMBER_ID,
    is_active: true,
    subscription_expiry: new Date(Date.now() + 86400000),
  };
  const conversationId = (await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1,'testclientRL','whatsapp')
    ON CONFLICT (business_id, client_phone, channel) DO UPDATE SET last_message_at = now() RETURNING id`,
    [business.id]
  )).rows[0].id;
  // El límite de esta suite es 3. El cuarto mensaje debe recibir una única advertencia.
  for (let i = 0; i < 4; i++) {
    await db.query(
      `INSERT INTO messages (conversation_id, direction, role, content) VALUES ($1,'inbound','user',$2)`,
      [conversationId, 'spam ' + i]
    );
  }

  let aiCalls = 0;
  const generateReply = async () => {
    aiCalls += 1;
    return 'respuesta que no debe enviarse';
  };
  await processInboundMessage(
    { business, from: 'testclientRL', text: 'cuarto', conversationId },
    { generateReply }
  );
  assert.strictEqual(whatsappService.sentInMock.length, 1);
  assert.strictEqual(whatsappService.sentInMock[0].text, RATE_LIMIT_MESSAGE);
  assert.strictEqual(aiCalls, 0);

  // El quinto mensaje sigue bloqueado, pero no repite la advertencia.
  await db.query(
    `INSERT INTO messages (conversation_id, direction, role, content)
     VALUES ($1, 'inbound', 'user', 'spam 4')`,
    [conversationId]
  );
  await processInboundMessage(
    { business, from: 'testclientRL', text: 'quinto', conversationId },
    { generateReply }
  );
  assert.strictEqual(whatsappService.sentInMock.length, 1, 'la advertencia no debe repetirse');
  assert.strictEqual(aiCalls, 0);
});

test('la dueña queda exenta del rate limit de clientas', async () => {
  const ownerPhone = 'testclient5215512345678';
  const business = {
    id: DEMO_BUSINESS_ID,
    wa_phone_number_id: DEMO_PHONE_NUMBER_ID,
    owner_phone: ownerPhone,
    is_active: true,
    subscription_expiry: new Date(Date.now() + 86400000),
  };
  const conversationId = (await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1,$2,'whatsapp')
     ON CONFLICT (business_id, client_phone, channel) DO UPDATE SET last_message_at = now() RETURNING id`,
    [business.id, ownerPhone]
  )).rows[0].id;
  for (let i = 0; i < 4; i++) {
    await db.query(
      `INSERT INTO messages (conversation_id, direction, role, content) VALUES ($1,'inbound','user',$2)`,
      [conversationId, 'mensaje admin ' + i]
    );
  }

  let aiCalls = 0;
  await processInboundMessage(
    { business, from: ownerPhone, text: 'consulta admin', conversationId },
    { generateReply: async ({ isAdmin }) => {
      aiCalls += 1;
      assert.strictEqual(isAdmin, true);
      return 'respuesta admin';
    } }
  );

  assert.strictEqual(aiCalls, 1);
  assert.strictEqual(whatsappService.sentInMock.length, 1);
  assert.strictEqual(whatsappService.sentInMock[0].text, 'respuesta admin');
});

test('un envío rechazado por Meta no se registra falsamente como outbound', async () => {
  const business = {
    id: DEMO_BUSINESS_ID,
    wa_phone_number_id: DEMO_PHONE_NUMBER_ID,
    is_active: true,
    subscription_expiry: new Date(Date.now() + 86400000),
  };
  const conversationId = (await db.query(
    `INSERT INTO conversations (business_id, client_phone, channel) VALUES ($1,'testclientFail','whatsapp')
     ON CONFLICT (business_id, client_phone, channel) DO UPDATE SET last_message_at = now() RETURNING id`,
    [business.id]
  )).rows[0].id;

  const originalSend = whatsappService.sendTextMessage;
  whatsappService.sendTextMessage = async () => ({ mode: 'real', ok: false });
  try {
    await assert.rejects(
      processInboundMessage({ business, from: 'testclientFail', conversationId }, { generateReply: async () => 'respuesta' }),
      /no aceptó/
    );
  } finally {
    whatsappService.sendTextMessage = originalSend;
  }

  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
    [conversationId]
  );
  assert.strictEqual(rows[0].n, 0);
});
