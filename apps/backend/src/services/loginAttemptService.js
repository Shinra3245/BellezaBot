// Rate limit en memoria para el login. Es suficiente para el MVP de una sola instancia;
// si Railway escala a varias réplicas se debe mover a Redis o PostgreSQL.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const attempts = new Map();

function keyFor(ip, email) {
  return `${ip || 'unknown'}:${String(email).toLowerCase()}`;
}

function getActiveEntry(key) {
  const entry = attempts.get(key);
  if (!entry) return null;
  if (Date.now() - entry.startedAt >= WINDOW_MS) {
    attempts.delete(key);
    return null;
  }
  return entry;
}

function check(ip, email) {
  const entry = getActiveEntry(keyFor(ip, email));
  if (!entry || entry.failures < MAX_FAILURES) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - entry.startedAt)) / 1000)),
  };
}

function recordFailure(ip, email) {
  const key = keyFor(ip, email);
  const entry = getActiveEntry(key) || { failures: 0, startedAt: Date.now() };
  entry.failures += 1;
  attempts.set(key, entry);
}

function clear(ip, email) {
  attempts.delete(keyFor(ip, email));
}

module.exports = { check, recordFailure, clear, MAX_FAILURES };

