// Aplica schema + seed exclusivamente en TEST_DATABASE_URL.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('Falta TEST_DATABASE_URL');
  if (testUrl === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL no puede ser la base productiva');

  const databaseName = new URL(testUrl).pathname.replace(/^\//, '').toLowerCase();
  if (!databaseName.includes('test')) throw new Error('La base de pruebas debe contener "test" en su nombre');

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  const pool = new Pool({ connectionString: testUrl });
  try {
    // Es una base exclusiva de pruebas y ya pasó las protecciones anteriores.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(schema);
    await pool.query(seed);
    console.log('[db:test:setup] Base de pruebas preparada correctamente.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[db:test:setup] Error:', err.message);
  process.exit(1);
});
