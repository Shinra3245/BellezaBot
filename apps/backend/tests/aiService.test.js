const { test, after } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const db = require('../src/config/db');
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
});

test('no entrega una respuesta de no disponibilidad hasta corregir una fecha pasada', async () => {
  let future = DateTime.now().setZone(business.timezone).plus({ days: 10 }).startOf('day');
  if (future.weekday === 7) future = future.plus({ days: 1 });
  const futureDate = future.toFormat('yyyy-MM-dd');
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
      content: [{ type: 'text', text: 'No hay disponibilidad.' }],
    },
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'future-date', name: 'check_availability',
        input: { date: futureDate, service_id: '22222222-2222-2222-2222-222222222201' },
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
    history: [{ role: 'user', content: 'Quiero agendar el 10 de agosto' }],
    client,
  });

  assert.strictEqual(reply, 'Sí hay horarios disponibles.');
  assert.strictEqual(client.calls.length, 4);
  const firstToolResult = client.calls[1].messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === 'tool_result' && block.tool_use_id === 'past-date');
  assert.match(firstToolResult.content, /fecha_pasada/);
  assert.match(firstToolResult.content, /fecha_actual/);
  assert.ok(
    client.calls[2].messages.some(
      (message) => typeof message.content === 'string' && message.content.includes('Corrección interna obligatoria')
    ),
    'debe forzar una nueva consulta antes de responder'
  );
});
