import { useEffect, useState } from 'react';
import { api } from '../../api/client';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Tenants() {
  const [businesses, setBusinesses] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', wa_phone: '', ownerEmail: '', ownerPassword: '' });
  const [error, setError] = useState('');

  async function load() {
    const { businesses } = await api.get('/admin/businesses');
    setBusinesses(businesses);
  }
  useEffect(() => { load(); }, []);

  async function extendMonth(b) {
    const base = b.subscription_expiry && new Date(b.subscription_expiry) > new Date()
      ? new Date(b.subscription_expiry) : new Date();
    base.setDate(base.getDate() + 30);
    await api.patch(`/admin/businesses/${b.id}`, { subscription_expiry: base.toISOString() });
    load();
  }
  async function toggleActive(b) {
    await api.patch(`/admin/businesses/${b.id}`, { is_active: !b.is_active });
    load();
  }
  async function createBusiness(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/admin/businesses', form);
      setForm({ name: '', wa_phone: '', ownerEmail: '', ownerPassword: '' });
      setShowNew(false);
      load();
    } catch (err) {
      setError(err.status === 409 ? 'Ya existe un negocio o usuario con esos datos' : 'No se pudo crear');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Negocios</h2>
        <button className="btn-primary sm" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Cerrar' : '+ Nuevo'}
        </button>
      </div>

      {showNew && (
        <form className="card form" onSubmit={createBusiness}>
          <input placeholder="Nombre del negocio" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="WhatsApp del negocio (+52...)" value={form.wa_phone} onChange={(e) => setForm({ ...form, wa_phone: e.target.value })} pattern="\+[1-9][0-9]{7,14}" required />
          <input type="email" placeholder="Correo de la dueña" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} required />
          <input type="password" minLength="16" autoComplete="new-password" placeholder="Contraseña inicial (mínimo 16 caracteres)" value={form.ownerPassword} onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })} required />
          {error && <p className="error">{error}</p>}
          <button className="btn-primary" type="submit">Crear negocio + dueña</button>
        </form>
      )}

      <ul className="list">
        {businesses.map((b) => (
          <li key={b.id} className="card">
            <div className="card-main">
              <strong>{b.name}</strong>
              <span className="muted">{b.owner_email || 'sin dueña'}</span>
              <span className={`badge ${b.subscription_ok ? 'badge-completed' : 'badge-cancelled'}`}>
                {b.subscription_ok ? 'Activa' : 'Vencida/Inactiva'}
              </span>
              <span className="muted">Vence: {fmtDate(b.subscription_expiry)}</span>
            </div>
            <div className="card-actions">
              <button className="btn-primary sm" onClick={() => extendMonth(b)}>+1 mes</button>
              <button onClick={() => toggleActive(b)}>{b.is_active ? 'Desactivar' : 'Activar'}</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
