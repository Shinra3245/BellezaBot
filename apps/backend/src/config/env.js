// Carga y validación de variables de entorno al arranque.
// Si falta alguna variable obligatoria de la fase actual, el proceso truena con un mensaje claro.
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const whatsappMode = process.env.WHATSAPP_MODE || 'real';
const aiMode = process.env.AI_MODE || 'real';

function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} debe ser un número entero mayor que cero`);
  }
  return value;
}

function commaSeparatedValues(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const REQUIRED = ['DATABASE_URL'];
if (nodeEnv === 'production') {
  REQUIRED.push('JWT_SECRET', 'FRONTEND_URL');
  if (whatsappMode === 'real') {
    REQUIRED.push('META_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_APP_SECRET');
  }
  if (aiMode === 'real') REQUIRED.push('ANTHROPIC_API_KEY');
}

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `[env] Faltan variables de entorno obligatorias: ${missing.join(', ')}.\n` +
      'Copia apps/backend/.env.example a apps/backend/.env y complétalas.'
  );
  process.exit(1);
}

if (!['real', 'mock'].includes(whatsappMode)) {
  throw new Error('WHATSAPP_MODE debe ser "real" o "mock"');
}
if (!['real', 'mock'].includes(aiMode)) {
  throw new Error('AI_MODE debe ser "real" o "mock"');
}
if (nodeEnv === 'production' && process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET debe tener al menos 32 caracteres en producción');
}

if (nodeEnv === 'production') {
  const origins = process.env.FRONTEND_URL.split(',').map((value) => value.trim()).filter(Boolean);
  if (origins.some((origin) => {
    try {
      return new URL(origin).origin !== origin;
    } catch {
      return true;
    }
  })) {
    throw new Error('FRONTEND_URL debe contener orígenes HTTPS válidos, sin ruta ni slash final');
  }
}

// Config validada y con valores por defecto seguros para lo opcional.
const env = {
  PORT: parseInt(process.env.PORT, 10) || 3001,
  NODE_ENV: nodeEnv,
  DATABASE_URL: process.env.DATABASE_URL,

  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_RESCHEDULE_TEMPLATE: process.env.META_RESCHEDULE_TEMPLATE || 'cita_reprogramada',
  // 'real' llama a la Graph API de Meta; 'mock' solo loguea (desarrollo sin tokens).
  WHATSAPP_MODE: whatsappMode,

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
  // 'real' llama a la API de Anthropic; 'mock' devuelve una respuesta fija (dev/pruebas sin gastar tokens).
  AI_MODE: aiMode,

  // El límite evita ciclos costosos. Los teléfonos permitidos para QA reciben
  // un margen mayor, pero nunca quedan sin una cota de seguridad.
  AI_MAX_TOOL_ITERATIONS: positiveIntegerFromEnv('AI_MAX_TOOL_ITERATIONS', 5),
  AI_EXTENDED_MAX_TOOL_ITERATIONS: positiveIntegerFromEnv('AI_EXTENDED_MAX_TOOL_ITERATIONS', 12),
  AI_EXTENDED_TOOL_PHONES: commaSeparatedValues('AI_EXTENDED_TOOL_PHONES'),

  CLIENT_RATE_LIMIT_PER_HOUR: positiveIntegerFromEnv('CLIENT_RATE_LIMIT_PER_HOUR', 30),

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  // Orígenes permitidos del panel web (lista separada por comas). Solo se aplica en producción.
  FRONTEND_URL: process.env.FRONTEND_URL,

  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'America/Mexico_City',
};

module.exports = env;
