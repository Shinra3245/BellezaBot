// Manejo de zonas horarias con luxon (librería única de fechas en el proyecto).
// Regla del plan: almacenar en TIMESTAMPTZ (UTC); convertir a la zona del negocio solo
// al mostrar o interpretar lenguaje natural.
const { DateTime } = require('luxon');

// Fecha/hora actual en la zona del negocio.
function nowInZone(timezone) {
  return DateTime.now().setZone(timezone);
}

// Día de la semana según la convención de schedules (0=Domingo … 6=Sábado, como JS Date.getDay()).
// luxon usa weekday 1=Lunes … 7=Domingo, por lo que `% 7` mapea Domingo(7)→0 y deja el resto igual.
function jsDayOfWeek(dt) {
  return dt.weekday % 7;
}

// Inicio del día (00:00) en la zona, a partir de una fecha 'YYYY-MM-DD'.
function startOfDay(dateStr, timezone) {
  return DateTime.fromISO(dateStr, { zone: timezone }).startOf('day');
}

// Combina una fecha base con una hora 'HH:MM' o 'HH:MM:SS' (formato TIME de Postgres).
function atTime(dayStart, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return dayStart.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

// Etiqueta legible en español para una hora, estilo WhatsApp: "4:00 p.m.".
function formatTime(dt) {
  return dt.setLocale('es').toFormat('h:mm a');
}

// Etiqueta legible completa en español: "viernes 8 de agosto, 4:00 p.m.".
function formatDateTime(dt) {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL, h:mm a");
}

// Interpreta un ISO (con o sin offset) como instante; si es naïve, se asume la zona del negocio.
function parseISO(iso, timezone) {
  return DateTime.fromISO(iso, { zone: timezone });
}

module.exports = {
  DateTime,
  nowInZone,
  jsDayOfWeek,
  startOfDay,
  atTime,
  formatTime,
  formatDateTime,
  parseISO,
};
