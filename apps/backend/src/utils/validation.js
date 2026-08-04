const { IANAZone } = require('luxon');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function isPositiveInteger(value, max = 1440) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max;
}

function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

function isValidE164(value) {
  return typeof value === 'string' && E164_RE.test(value);
}

function isValidTimezone(value) {
  return typeof value === 'string' && IANAZone.isValidZone(value);
}

module.exports = {
  isNonEmptyString,
  isNonNegativeNumber,
  isPositiveInteger,
  isValidTime,
  isValidEmail,
  isValidE164,
  isValidTimezone,
};

