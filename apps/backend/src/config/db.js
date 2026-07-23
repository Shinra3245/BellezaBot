const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

// Un error en un cliente inactivo del pool no debe tumbar el proceso.
pool.on('error', (err) => {
  console.error('[db] Error inesperado en cliente del pool de PostgreSQL:', err.message);
});

module.exports = {
  // Toda consulta pasa por aquí; siempre parametrizada (text, params).
  query: (text, params) => pool.query(text, params),
  pool,
};
