// Carga y validación de variables de entorno al arranque.
// Si falta alguna variable obligatoria de la fase actual, el proceso truena con un mensaje claro.
require('dotenv').config();

// Variables obligatorias por fase. Se van habilitando conforme avanza el checklist del plan
// para que el servidor arranque en fases tempranas sin exigir secretos que aún no aplican.
const REQUIRED = [
  'DATABASE_URL', // Fase 0: sin base de datos no hay /health ni nada útil
  // 'META_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_APP_SECRET', // Fase 1
  // 'ANTHROPIC_API_KEY', // Fase 2
  // 'JWT_SECRET', // Fase 5
];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `[env] Faltan variables de entorno obligatorias: ${missing.join(', ')}.\n` +
      'Copia apps/backend/.env.example a apps/backend/.env y complétalas.'
  );
  process.exit(1);
}

// Config validada y con valores por defecto seguros para lo opcional.
const env = {
  PORT: parseInt(process.env.PORT, 10) || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL,

  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  // 'real' llama a la Graph API de Meta; 'mock' solo loguea (desarrollo sin tokens).
  WHATSAPP_MODE: process.env.WHATSAPP_MODE || 'real',

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
  // 'real' llama a la API de Anthropic; 'mock' devuelve una respuesta fija (dev/pruebas sin gastar tokens).
  AI_MODE: process.env.AI_MODE || 'real',

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'America/Mexico_City',
};

module.exports = env;
