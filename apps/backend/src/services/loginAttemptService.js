// Rate limit en memoria para el login. Es suficiente para el MVP de una sola instancia;
// si Railway escala a varias réplicas se debe mover a Redis o PostgreSQL.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_EMAIL_FAILURES = 10;
const MAX_IP_FAILURES = 50;
const MAX_TRACKED_KEYS = 10000;
const emailAttempts = new Map();
const ipAttempts = new Map();

function normalizeEmail(email) {
  return String(email).toLowerCase().trim();
}

function normalizeIp(ip) {
  return String(ip || 'unknown').trim();
}

function getActiveEntry(store, key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.startedAt >= WINDOW_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

function blockedResult(entry) {
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - entry.startedAt)) / 1000)),
  };
}

function check(ip, email) {
  // El correo es la protección principal: permanece estable aunque Railway cambie la IP
  // interna del proxy entre solicitudes. La IP complementa contra ataques a muchas cuentas.
  const emailEntry = getActiveEntry(emailAttempts, normalizeEmail(email));
  if (emailEntry && emailEntry.failures >= MAX_EMAIL_FAILURES) return blockedResult(emailEntry);

  const ipEntry = getActiveEntry(ipAttempts, normalizeIp(ip));
  if (ipEntry && ipEntry.failures >= MAX_IP_FAILURES) return blockedResult(ipEntry);
  return { allowed: true };
}

function increment(store, key) {
  const entry = getActiveEntry(store, key) || { failures: 0, startedAt: Date.now() };
  entry.failures += 1;
  store.set(key, entry);
  trimStore(store);
}

function trimStore(store) {
  if (store.size <= MAX_TRACKED_KEYS) return;
  for (const [key] of store) {
    if (!getActiveEntry(store, key) || store.size > MAX_TRACKED_KEYS) store.delete(key);
    if (store.size <= MAX_TRACKED_KEYS) break;
  }
}

function recordFailure(ip, email) {
  increment(emailAttempts, normalizeEmail(email));
  increment(ipAttempts, normalizeIp(ip));
}

function clear(ip, email) {
  // Un login correcto rehabilita la cuenta, pero no borra el historial de ataques de la IP.
  emailAttempts.delete(normalizeEmail(email));
}

module.exports = {
  check,
  recordFailure,
  clear,
  MAX_EMAIL_FAILURES,
  MAX_IP_FAILURES,
};
