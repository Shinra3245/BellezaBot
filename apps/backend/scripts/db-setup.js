// Aplica schema.sql y seed.sql sobre la base apuntada por DATABASE_URL.
// Uso: node scripts/db-setup.js  (requiere DATABASE_URL en el entorno o .env)
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

async function main() {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('[db:setup] Falta DATABASE_URL. Copia .env.example a .env y complétala.');
    process.exit(1);
  }

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    console.log('[db:setup] Aplicando schema.sql ...');
    await pool.query(schema);
    console.log('[db:setup] Aplicando seed.sql ...');
    await pool.query(seed);
    const { rows } = await pool.query('SELECT name FROM businesses ORDER BY created_at');
    console.log('[db:setup] Listo. Negocios en la BD:', rows.map((r) => r.name).join(', '));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[db:setup] Error:', err.message);
  process.exit(1);
});
