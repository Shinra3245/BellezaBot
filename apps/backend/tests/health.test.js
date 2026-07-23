const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../src/app');
const db = require('../src/config/db');

const app = createApp();

after(async () => {
  await db.pool.end();
});

test('GET /health responde { ok: true } cuando la BD está accesible', async () => {
  const res = await request(app).get('/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});

test('GET / responde que el backend está vivo', async () => {
  const res = await request(app).get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /vivo/i);
});
