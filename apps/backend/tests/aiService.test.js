const { test, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
const env = require('../src/config/env');
const aiService = require('../src/services/aiService');

after(async () => {
  await db.pool.end();
});

const business = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Estética Demo',
  bot_name: 'Bella',
  bot_personality: 'amable',
  tone: 'informal',
  timezone: 'America/Mexico_City',
  wa_phone_number_id: 'DEMO',
};

// Cliente falso de Anthropic: responde con un guion (primero pide una tool, luego texto final).
function fakeClient(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return script[i++];
      },
    },
  };
}

test('generateReply ejecuta el loop de tool_use y devuelve el texto final', async () => {
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'get_service_info', input: {} }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Tenemos Manicure, Pedicure y Uñas acrílicas 💅' }],
    },
  ]);

  const reply = await aiService.generateReply({
    business,
    clientPhone: 'testclient-ai',
    history: [{ role: 'user', content: '¿qué servicios tienen?' }],
    client,
  });

  assert.match(reply, /Manicure/);
  // Se hicieron 2 llamadas a la API (tool_use → texto final).
  assert.strictEqual(client.calls.length, 2);
  // La 2ª llamada incluye el tool_result del get_service_info en el historial.
  const secondCallMessages = client.calls[1].messages;
  const toolResultMsg = secondCallMessages.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
  );
  assert.ok(toolResultMsg, 'debe haberse agregado el tool_result al historial');
  const toolResult = toolResultMsg.content.find((b) => b.type === 'tool_result');
  assert.match(toolResult.content, /Manicure/); // datos reales de la BD
});

test('generateReply corta el texto vacío con un mensaje de cortesía', async () => {
  const client = fakeClient([{ stop_reason: 'end_turn', content: [] }]);
  const reply = await aiService.generateReply({
    business, clientPhone: 'testclient-ai', history: [{ role: 'user', content: 'hola' }], client,
  });
  assert.ok(reply.length > 0);
});

test('un teléfono de QA usa el límite ampliado sin quedar ilimitado', async () => {
  const previousPhones = env.AI_EXTENDED_TOOL_PHONES;
  const previousExtendedLimit = env.AI_EXTENDED_MAX_TOOL_ITERATIONS;
  env.AI_EXTENDED_TOOL_PHONES = ['525511223344'];
  env.AI_EXTENDED_MAX_TOOL_ITERATIONS = 12;

  const repeatedToolCalls = Array.from({ length: 6 }, (_, index) => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `services-${index}`, name: 'get_service_info', input: {} }],
  }));
  const client = fakeClient([
    ...repeatedToolCalls,
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Flujo de QA completado.' }] },
  ]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone: '+52 55 1122 3344',
      history: [{ role: 'user', content: 'Realiza una prueba extensa' }],
      client,
    });
    assert.strictEqual(reply, 'Flujo de QA completado.');
    assert.strictEqual(client.calls.length, 7);
  } finally {
    env.AI_EXTENDED_TOOL_PHONES = previousPhones;
    env.AI_EXTENDED_MAX_TOOL_ITERATIONS = previousExtendedLimit;
  }
});

test('el system prompt cachea el bloque estable y deja la fecha en un bloque volátil', async () => {
  let captured;
  const client = {
    messages: {
      create: async (params) => {
        captured = params;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    },
  };
  await aiService.generateReply({
    business, clientPhone: 'x', history: [{ role: 'user', content: 'hola' }], client,
  });
  assert.strictEqual(captured.system.length, 2);
  assert.deepStrictEqual(captured.system[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(captured.system[1].cache_control, undefined);
  assert.match(captured.system[1].text, /Fecha y hora actual/);
  assert.match(captured.system[1].text, /Fecha actual ISO: \d{4}-\d{2}-\d{2}/);
  assert.match(captured.system[0].text, /próxima ocurrencia futura/);
  assert.match(captured.system[0].text, /fecha_pasada/);
  assert.match(captured.system[0].text, /preferred_time/);
  assert.match(captured.system[0].text, /create_appointment devolvió/);
  const availabilityTool = captured.tools.find((tool) => tool.name === 'check_availability');
  assert.ok(availabilityTool.input_schema.properties.preferred_time);
});

test('obliga a consultar la hora exacta y rechaza el empalme aunque la IA intente pedir el nombre', async () => {
  let appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 18 }).startOf('day');
  if (appointmentDay.weekday === 7) appointmentDay = appointmentDay.plus({ days: 1 });
  const date = appointmentDay.toFormat('yyyy-MM-dd');
  const clientPhone = 'testclient-ai-exact-overlap';

  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Manicure previo',
      appointmentDay.set({ hour: 18, minute: 15 }).toISO(),
      appointmentDay.set({ hour: 19, minute: 0 }).toISO(),
    ]
  );

  // Primero la IA intenta pedir el nombre sin consultar. Tras la corrección interna,
  // llama la tool pero omite preferred_time. El backend debe recuperar 18:00 del
  // mensaje y consultar esa hora exacta para Pedicure, que se empalma con 18:15–19:00.
  const client = fakeClient([
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sí está disponible. ¿A qué nombre agendo la cita?' }],
    },
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'availability-without-time', name: 'check_availability',
        input: {
          date,
          service_id: '22222222-2222-2222-2222-222222222202',
        },
      }],
    },
  ]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone: 'client-requesting-overlap',
      history: [{
        role: 'user',
        content: `Quiero agendar un pedicure el ${date} a las 6;00 p. m.`,
      }],
      client,
    });

    assert.match(reply, /6:00 p\. m\./);
    assert.match(reply, /no está disponible/);
    assert.strictEqual(client.calls.length, 2);
    assert.ok(
      client.calls[1].messages.some(
        (message) => typeof message.content === 'string' && message.content.includes('no ejecutaste check_availability')
      ),
      'debe bloquear la solicitud del nombre y forzar una consulta real'
    );
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('al elegir otro día fuerza la fecha nueva y excluye la cita que ya ocupa ese horario', async () => {
  let targetDay = DateTime.now().setZone(business.timezone).plus({ days: 10 }).startOf('day');
  while (targetDay.weekday !== 1) targetDay = targetDay.plus({ days: 1 });
  const wrongDay = targetDay.minus({ days: 1 });
  const clientPhone = 'testclient-ai-date-change';
  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Horario ya ocupado',
      targetDay.set({ hour: 10 }).toISO(),
      targetDay.set({ hour: 10, minute: 45 }).toISO(),
    ]
  );
  const monthName = targetDay.setLocale('es').toFormat('LLLL');
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'wrong-date', name: 'check_availability',
        input: {
          date: wrongDay.toFormat('yyyy-LL-dd'),
          service_id: '22222222-2222-2222-2222-222222222201',
        },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Estos son los horarios disponibles del día correcto.' }],
    },
  ]);

  try {
    await aiService.generateReply({
      business,
      clientPhone: 'client-selecting-new-date',
      history: [
        {
          role: 'assistant',
          content: `Puedo ofrecerte el lunes ${targetDay.day} de ${monthName}. ¿Te queda bien?`,
        },
        { role: 'user', content: `Sí, el día ${targetDay.day} está bien` },
      ],
      client,
    });

    const resultMessage = client.calls[1].messages.find(
      (message) => Array.isArray(message.content) &&
        message.content.some((block) => block.tool_use_id === 'wrong-date')
    );
    const resultBlock = resultMessage.content.find((block) => block.tool_use_id === 'wrong-date');
    const availability = JSON.parse(resultBlock.content);
    assert.strictEqual(availability.fecha_solicitada, targetDay.toFormat('yyyy-LL-dd'));
    assert.ok(
      availability.disponibilidad.every((slot) => {
        const startsAt = DateTime.fromISO(slot.datetime_iso).setZone(business.timezone);
        return startsAt.hour !== 10 || startsAt.minute !== 0;
      }),
      'el horario de las 10:00 ocupado no debe volver a ofrecerse'
    );
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('una confirmación verbal no sale hasta que create_appointment guarde realmente la cita', async () => {
  let appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 20 }).startOf('day');
  if (appointmentDay.weekday === 7) appointmentDay = appointmentDay.plus({ days: 1 });
  const appointmentIso = appointmentDay.set({ hour: 18, minute: 15 }).toISO();
  const clientPhone = 'testclient-ai-create-guard';
  const client = fakeClient([
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '¡Listo! Tu cita está confirmada 🎉' }],
    },
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'create-real', name: 'create_appointment',
        input: {
          service_id: '22222222-2222-2222-2222-222222222201',
          datetime_iso: appointmentIso,
          client_name: 'Prueba guardia IA',
        },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Ahora sí, tu cita está confirmada 🎉' }],
    },
  ]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone,
      history: [
        { role: 'assistant', content: '¿Todo correcto? ¿Confirmo tu cita de Manicure?' },
        { role: 'user', content: 'Sí, confirmo' },
      ],
      client,
    });

    assert.strictEqual(reply, 'Ahora sí, tu cita está confirmada 🎉');
    assert.strictEqual(client.calls.length, 3);
    assert.ok(
      client.calls[1].messages.some(
        (message) => typeof message.content === 'string' && message.content.includes('todavía no ejecutaste create_appointment')
      ),
      'debe bloquear la confirmación falsa y forzar la tool'
    );
    const stored = await db.query(
      `SELECT status FROM appointments
       WHERE business_id = $1 AND client_phone = $2 AND client_name = $3`,
      [business.id, clientPhone, 'Prueba guardia IA']
    );
    assert.strictEqual(stored.rows.length, 1);
    assert.strictEqual(stored.rows[0].status, 'confirmed');
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('si create_appointment falla, bloquea la confirmación falsa y comunica el error', async () => {
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'create-failed', name: 'create_appointment',
        input: {
          service_id: '22222222-2222-2222-2222-222222222201',
          datetime_iso: '2024-08-10T10:00:00-06:00',
          client_name: 'No debe guardarse',
        },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '¡Listo! Tu cita está confirmada.' }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'No pude crear la cita porque esa fecha ya pasó.' }],
    },
  ]);

  const reply = await aiService.generateReply({
    business,
    clientPhone: 'testclient-ai-create-error',
    history: [
      { role: 'assistant', content: '¿Confirmo tu cita?' },
      { role: 'user', content: 'Sí, confirmo' },
    ],
    client,
  });

  assert.strictEqual(reply, 'No pude crear la cita porque esa fecha ya pasó.');
  assert.strictEqual(client.calls.length, 3);
  assert.ok(
    client.calls[2].messages.some(
      (message) => typeof message.content === 'string' && message.content.includes('create_appointment falló')
    ),
    'debe informar internamente el error real antes de responder'
  );
});

test('si se agota el límite después de un empalme responde el error real y no el mensaje genérico', async () => {
  const previousLimit = env.AI_MAX_TOOL_ITERATIONS;
  env.AI_MAX_TOOL_ITERATIONS = 1;
  let appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 9 }).startOf('day');
  if (appointmentDay.weekday === 7) appointmentDay = appointmentDay.plus({ days: 1 });
  const existingPhone = 'testclient-ai-limit-overlap-existing';
  const requestingPhone = 'testclient-ai-limit-overlap-new';
  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      existingPhone,
      'Cita existente',
      appointmentDay.set({ hour: 10 }).toISO(),
      appointmentDay.set({ hour: 10, minute: 45 }).toISO(),
    ]
  );
  const client = fakeClient([{
    stop_reason: 'tool_use',
    content: [{
      type: 'tool_use', id: 'create-overlap-at-limit', name: 'create_appointment',
      input: {
        service_id: '22222222-2222-2222-2222-222222222201',
        datetime_iso: appointmentDay.set({ hour: 10 }).toISO(),
        client_name: 'No debe duplicarse',
      },
    }],
  }]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone: requestingPhone,
      history: [
        { role: 'assistant', content: '¿Todo correcto? ¿Confirmo tu cita de Manicure?' },
        { role: 'user', content: 'Sí, confirmo' },
      ],
      client,
    });

    assert.match(reply, /ya no está disponible/);
    assert.doesNotMatch(reply, /Dame un momento/);
    const duplicates = await db.query(
      'SELECT count(*)::int AS total FROM appointments WHERE business_id = $1 AND client_phone = $2',
      [business.id, requestingPhone]
    );
    assert.strictEqual(duplicates.rows[0].total, 0);
  } finally {
    env.AI_MAX_TOOL_ITERATIONS = previousLimit;
    await db.query(
      'DELETE FROM appointments WHERE business_id = $1 AND client_phone = ANY($2)',
      [business.id, [existingPhone, requestingPhone]]
    );
  }
});

test('no ejecuta cancel_appointment antes de pedir confirmación explícita', async () => {
  const appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 13 }).startOf('day');
  const clientPhone = 'testclient-ai-cancel-confirmation';
  const inserted = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
     RETURNING id`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Prueba confirmación requerida',
      appointmentDay.set({ hour: 16 }).toISO(),
      appointmentDay.set({ hour: 16, minute: 45 }).toISO(),
    ]
  );
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'premature-cancel', name: 'cancel_appointment',
        input: { appointment_id: inserted.rows[0].id },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '¿Confirmas que deseas cancelar esta cita? Responde Sí o No.' }],
    },
  ]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone,
      history: [{ role: 'user', content: 'Cancela mi cita del sábado' }],
      client,
    });

    assert.match(reply, /¿Confirmas que deseas cancelar/);
    const toolResult = client.calls[1].messages.find(
      (message) => Array.isArray(message.content) &&
        message.content.some((block) => block.tool_use_id === 'premature-cancel')
    );
    assert.match(JSON.stringify(toolResult), /confirmacion_cancelacion_requerida/);
    const stored = await db.query('SELECT status FROM appointments WHERE id = $1', [inserted.rows[0].id]);
    assert.strictEqual(stored.rows[0].status, 'confirmed');
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('una confirmación de cancelación bloquea create_appointment y cancela la cita real', async () => {
  const appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 14 }).startOf('day');
  const clientPhone = 'testclient-ai-cancel-guard';
  const inserted = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'rescheduled')
     RETURNING id`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Prueba cancelación protegida',
      appointmentDay.set({ hour: 16 }).toISO(),
      appointmentDay.set({ hour: 16, minute: 45 }).toISO(),
    ]
  );
  const appointmentId = inserted.rows[0].id;
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'wrong-create', name: 'create_appointment',
        input: {
          service_id: '22222222-2222-2222-2222-222222222201',
          datetime_iso: appointmentDay.set({ hour: 17 }).toISO(),
          client_name: 'No debe crearse',
        },
      }],
    },
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'list-before-cancel', name: 'get_my_appointments', input: {} }],
    },
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'cancel-real', name: 'cancel_appointment',
        input: { appointment_id: appointmentId },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '✅ Tu cita ha sido cancelada.' }],
    },
  ]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone,
      history: [
        {
          role: 'assistant',
          content: 'Voy a cancelar tu cita de Uñas acrílicas. ¿Confirmas que deseas cancelarla?',
        },
        { role: 'user', content: 'Sí, cancélala' },
      ],
      client,
    });

    assert.strictEqual(reply, '✅ Tu cita ha sido cancelada.');
    assert.strictEqual(client.calls.length, 4);
    const blockedToolResult = client.calls[1].messages.find(
      (message) => Array.isArray(message.content) &&
        message.content.some((block) => block.tool_use_id === 'wrong-create')
    );
    assert.match(JSON.stringify(blockedToolResult), /cancelacion_pendiente/);

    const stored = await db.query(
      `SELECT client_name, status FROM appointments
       WHERE business_id = $1 AND client_phone = $2
       ORDER BY created_at`,
      [business.id, clientPhone]
    );
    assert.deepStrictEqual(
      stored.rows.map((row) => ({ client_name: row.client_name, status: row.status })),
      [{ client_name: 'Prueba cancelación protegida', status: 'cancelled' }]
    );
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('no afirma una cancelación cuando cancel_appointment falla', async () => {
  const appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 15 }).startOf('day');
  const clientPhone = 'testclient-ai-cancel-error';
  const inserted = await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
     RETURNING id`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Prueba cancelación fallida',
      appointmentDay.set({ hour: 16 }).toISO(),
      appointmentDay.set({ hour: 16, minute: 45 }).toISO(),
    ]
  );
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'cancel-missing', name: 'cancel_appointment',
        input: { appointment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Tu cita ha sido cancelada.' }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'No pude cancelar la cita porque no pude identificarla.' }],
    },
  ]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone,
      history: [
        { role: 'assistant', content: '¿Confirmas que deseas cancelar esta cita?' },
        { role: 'user', content: 'Sí, confirmo' },
      ],
      client,
    });

    assert.strictEqual(reply, 'No pude cancelar la cita porque no pude identificarla.');
    assert.strictEqual(client.calls.length, 3);
    assert.ok(
      client.calls[2].messages.some(
        (message) => typeof message.content === 'string' && message.content.includes('cancel_appointment falló')
      ),
      'debe informar internamente el error real antes de responder'
    );
    const stored = await db.query('SELECT status FROM appointments WHERE id = $1', [inserted.rows[0].id]);
    assert.strictEqual(stored.rows[0].status, 'confirmed');
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('el modo admin consulta la fecha exacta y no puede ocultar citas reales con una respuesta vacía', async () => {
  let appointmentDay = DateTime.now().setZone(business.timezone).plus({ days: 12 }).startOf('day');
  if (appointmentDay.weekday === 7) appointmentDay = appointmentDay.plus({ days: 1 });
  const monthName = appointmentDay.setLocale('es').toFormat('LLLL');
  const clientPhone = 'testclient-admin-agenda-guard';
  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Prueba agenda admin',
      appointmentDay.set({ hour: 17, minute: 30 }).toISO(),
      appointmentDay.set({ hour: 18, minute: 15 }).toISO(),
    ]
  );

  const client = fakeClient([]);

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone: 'owner-test',
      history: [{
        role: 'user',
        content: `Dame el resumen de citas del día ${appointmentDay.day} de ${monthName} del ${appointmentDay.year}`,
      }],
      client,
      isAdmin: true,
    });

    assert.match(reply, /Prueba agenda admin/);
    assert.match(reply, /✅ Confirmada/);
    assert.doesNotMatch(reply, /\|/);
    assert.strictEqual(client.calls.length, 0, 'la consulta reconocida no debe depender de Anthropic');
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('la siguiente semana se consulta directamente y se formatea sin tablas ni días inventados', async () => {
  const client = fakeClient([]);
  const nextWeekStart = DateTime.now().setZone(business.timezone).plus({ weeks: 1 }).startOf('week');
  const clientPhone = 'testclient-admin-next-week';
  await db.query(
    `INSERT INTO appointments (business_id, service_id, client_phone, client_name, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')`,
    [
      business.id,
      '22222222-2222-2222-2222-222222222201',
      clientPhone,
      'Cita siguiente semana',
      nextWeekStart.set({ hour: 10 }).toISO(),
      nextWeekStart.set({ hour: 10, minute: 45 }).toISO(),
    ]
  );

  try {
    const reply = await aiService.generateReply({
      business,
      clientPhone: 'owner-test',
      history: [{ role: 'user', content: 'Dame el resumen de citas de la siguiente semana' }],
      client,
      isAdmin: true,
    });

    const weekEnd = nextWeekStart.plus({ days: 6 });
    assert.match(reply, /📅 \*Resumen semanal\*/);
    assert.match(reply, new RegExp(`${nextWeekStart.toFormat('d')}.*${weekEnd.toFormat('d')}`));
    assert.match(reply, /Total: \*1 cita\*/);
    assert.match(reply, /Lunes: 1 cita/);
    assert.doesNotMatch(reply, /\|/);
    assert.doesNotMatch(reply, /Martes: 0|Miércoles: 0/);
    assert.strictEqual(client.calls.length, 0, 'la consulta semanal reconocida no debe depender de Anthropic');
  } finally {
    await db.query('DELETE FROM appointments WHERE business_id = $1 AND client_phone = $2', [business.id, clientPhone]);
  }
});

test('corrige el año de una fecha pasada antes de consultar disponibilidad', async () => {
  let future = DateTime.now().setZone(business.timezone).plus({ days: 10 }).startOf('day');
  if (future.weekday === 7) future = future.plus({ days: 1 });
  const futureDate = future.toFormat('yyyy-MM-dd');
  const monthName = future.setLocale('es').toFormat('LLLL');
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'past-date', name: 'check_availability',
        input: { date: '2024-08-10', service_id: '22222222-2222-2222-2222-222222222201' },
      }],
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sí hay horarios disponibles.' }],
    },
  ]);

  const reply = await aiService.generateReply({
    business,
    clientPhone: 'testclient-ai',
    history: [{ role: 'user', content: `Quiero agendar el ${future.day} de ${monthName}` }],
    client,
  });

  assert.strictEqual(reply, 'Sí hay horarios disponibles.');
  assert.strictEqual(client.calls.length, 2);
  const firstToolResult = client.calls[1].messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === 'tool_result' && block.tool_use_id === 'past-date');
  const availability = JSON.parse(firstToolResult.content);
  assert.strictEqual(availability.fecha_solicitada, futureDate);
  assert.notStrictEqual(availability.nota, 'fecha_pasada');
});
