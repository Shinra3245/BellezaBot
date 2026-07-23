// Logger mínimo con nivel y prefijo. En la Fase 3 se reemplaza por uno estructurado (pino)
// con business_id en cada línea. Por ahora centraliza la salida para no dispersar console.log.
function line(level, msg, meta) {
  const ts = new Date().toISOString();
  const extra = meta ? ` ${JSON.stringify(meta)}` : '';
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${ts}] [${level}] ${msg}${extra}`);
}

module.exports = {
  info: (msg, meta) => line('info', msg, meta),
  warn: (msg, meta) => line('warn', msg, meta),
  error: (msg, meta) => line('error', msg, meta),
};
