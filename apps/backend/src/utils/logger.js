// Logger estructurado con pino. Mantiene la interfaz info/warn/error(msg, meta)
// para no tocar las llamadas existentes; `meta` (con business_id, etc.) se emite como campos JSON.
const pino = require('pino');
const env = require('../config/env');

const base = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
});

const wrap = (level) => (msg, meta) => base[level](meta || {}, msg);

module.exports = {
  info: wrap('info'),
  warn: wrap('warn'),
  error: wrap('error'),
};
