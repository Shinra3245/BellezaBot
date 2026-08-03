// Autenticación del panel: hash de contraseñas (bcrypt) y emisión/validación de JWT.
// El JWT lleva { userId, businessId, role, tokenVersion }; la revocación remota se logra
// incrementando token_version en la BD (invalida todos los tokens previos del usuario).
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const env = require('../config/env');

const BCRYPT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Firma un JWT para un usuario ya autenticado.
function signToken(user) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET no configurado');
  return jwt.sign(
    {
      userId: user.id,
      businessId: user.business_id,
      role: user.role,
      tokenVersion: user.token_version,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

// Verifica firma y expiración; devuelve el payload decodificado o lanza.
function verifyToken(token) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET no configurado');
  return jwt.verify(token, env.JWT_SECRET);
}

async function findUserByEmail(email) {
  const { rows } = await db.query(
    `SELECT id, business_id, email, password_hash, role, token_version
     FROM users WHERE email = $1`,
    [email]
  );
  return rows[0] || null;
}

// token_version actual del usuario (para validar revocación en cada request).
async function getTokenVersion(userId) {
  const { rows } = await db.query('SELECT token_version FROM users WHERE id = $1', [userId]);
  return rows.length ? rows[0].token_version : null;
}

/**
 * Valida credenciales y devuelve { token, user } o null si son inválidas.
 * No revela si el fallo fue por email inexistente o contraseña incorrecta.
 */
async function login(email, password) {
  const user = await findUserByEmail(email);
  if (!user) return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  return {
    token: signToken(user),
    user: { id: user.id, email: user.email, role: user.role, business_id: user.business_id },
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  findUserByEmail,
  getTokenVersion,
  login,
};
