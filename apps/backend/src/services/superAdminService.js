// Operaciones exclusivas del super-admin (el dueño del SaaS): gestión de negocios (tenants),
// control manual de suscripciones y revocación de sesiones. Protegidas por requireRole('superadmin').
const db = require('../config/db');
const authService = require('./authService');

// Lista de negocios con su estado de suscripción (vigente si is_active y no vencida).
async function listBusinesses() {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.wa_phone, b.owner_phone, b.is_active, b.subscription_expiry,
            b.created_at,
            (b.is_active AND (b.subscription_expiry IS NULL OR b.subscription_expiry > now())) AS subscription_ok,
            (SELECT email FROM users u WHERE u.business_id = b.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email
     FROM businesses b
     ORDER BY b.created_at DESC`
  );
  return rows;
}

// Actualiza suscripción / activación de un negocio (control manual del super-admin).
async function updateBusiness(businessId, fields) {
  const allowed = ['subscription_expiry', 'is_active'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (sets.length === 0) return { error: 'sin_cambios' };
  values.push(businessId);
  const { rows } = await db.query(
    `UPDATE businesses SET ${sets.join(', ')} WHERE id = $${values.length}
     RETURNING id, name, is_active, subscription_expiry`,
    values
  );
  if (rows.length === 0) return { error: 'no_encontrado' };
  return rows[0];
}

/**
 * Alta manual de un negocio + su usuario owner (flujo de onboarding del super-admin).
 * Transacción: si falla la creación del usuario, no queda un negocio huérfano.
 */
async function createBusiness({ name, wa_phone, wa_phone_number_id, owner_phone, timezone, ownerEmail, ownerPassword, subscriptionDays = 30 }) {
  const passwordHash = await authService.hashPassword(ownerPassword);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: bizRows } = await client.query(
      `INSERT INTO businesses (name, wa_phone, wa_phone_number_id, owner_phone, timezone, subscription_expiry)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'America/Mexico_City'), now() + ($6 || ' days')::interval)
       RETURNING id, name, subscription_expiry`,
      [name, wa_phone, wa_phone_number_id || null, owner_phone || null, timezone || null, String(subscriptionDays)]
    );
    const business = bizRows[0];
    const { rows: userRows } = await client.query(
      `INSERT INTO users (business_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'owner') RETURNING id, email, role`,
      [business.id, String(ownerEmail).toLowerCase().trim(), passwordHash]
    );
    await client.query('COMMIT');
    return { business, owner: userRows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Violación de UNIQUE (wa_phone o email ya existentes) → error de negocio, no 500.
    if (err.code === '23505') return { error: 'duplicado', detail: err.detail };
    throw err;
  } finally {
    client.release();
  }
}

// Revoca todas las sesiones de un usuario incrementando su token_version.
async function revokeUserTokens(userId) {
  const { rows } = await db.query(
    `UPDATE users SET token_version = token_version + 1
     WHERE id = $1 RETURNING id, token_version`,
    [userId]
  );
  if (rows.length === 0) return { error: 'no_encontrado' };
  return rows[0];
}

module.exports = {
  listBusinesses,
  updateBusiness,
  createBusiness,
  revokeUserTokens,
};
