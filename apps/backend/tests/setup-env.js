// Protección global de la suite: las pruebas de integración escriben y borran datos.
// Nunca deben reutilizar DATABASE_URL, que puede apuntar a Supabase productivo.
require('dotenv').config();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
// node:test crea procesos hijos que vuelven a cargar este archivo. Conservamos la URL primaria
// original para compararla sin confundirla con DATABASE_URL, que ya sustituimos por la de pruebas.
const primaryDatabaseUrl = process.env.BELLEZABOT_PRIMARY_DATABASE_URL || process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'Falta TEST_DATABASE_URL. Configura una base PostgreSQL exclusiva para pruebas; ' +
      'la suite nunca utilizará DATABASE_URL.'
  );
}

if (testDatabaseUrl === primaryDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL no puede ser igual a DATABASE_URL de producción.');
}

let databaseName;
try {
  databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '').toLowerCase();
} catch {
  throw new Error('TEST_DATABASE_URL no es una URL PostgreSQL válida.');
}

if (!databaseName.includes('test')) {
  throw new Error('El nombre de la base de TEST_DATABASE_URL debe contener "test" como protección adicional.');
}

process.env.NODE_ENV = 'test';
process.env.BELLEZABOT_PRIMARY_DATABASE_URL = primaryDatabaseUrl || '';
process.env.DATABASE_URL = testDatabaseUrl;
process.env.WHATSAPP_MODE = 'mock';
process.env.AI_MODE = 'mock';
process.env.JWT_SECRET = process.env.TEST_JWT_SECRET || 'bellezabot-test-secret-no-usar-en-produccion';
