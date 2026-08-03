import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function Services() {
  const [services, setServices] = useState([]);
  const [form, setForm] = useState({ name: '', price: '', duration_minutes: '' });
  const [error, setError] = useState('');

  async function load() {
    const { services } = await api.get('/panel/services');
    setServices(services);
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/panel/services', {
        name: form.name.trim(),
        price: Number(form.price),
        duration_minutes: Number(form.duration_minutes),
      });
      setForm({ name: '', price: '', duration_minutes: '' });
      load();
    } catch {
      setError('No se pudo crear el servicio');
    }
  }
  async function updatePrice(id, price) {
    await api.patch(`/panel/services/${id}`, { price: Number(price) });
    load();
  }
  async function remove(id) {
    if (!confirm('¿Desactivar este servicio? Dejará de ofrecerse a las clientas.')) return;
    await api.del(`/panel/services/${id}`);
    load();
  }

  return (
    <div className="page">
      <h2>Servicios</h2>

      <form className="card form" onSubmit={create}>
        <input placeholder="Nombre (ej. Manicure)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <div className="row gap">
          <input type="number" min="0" step="1" placeholder="Precio $" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
          <input type="number" min="5" step="5" placeholder="Duración (min)" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} required />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn-primary" type="submit">Agregar servicio</button>
      </form>

      <ul className="list">
        {services.map((s) => (
          <li key={s.id} className={`card ${s.is_active ? '' : 'inactive'}`}>
            <div className="card-main">
              <strong>{s.name}</strong>
              <span className="muted">{s.duration_minutes} min {s.is_active ? '' : '· (inactivo)'}</span>
            </div>
            <div className="card-actions">
              <label className="inline-edit">
                $<input type="number" defaultValue={Number(s.price)} onBlur={(e) => updatePrice(s.id, e.target.value)} />
              </label>
              {s.is_active && <button onClick={() => remove(s.id)}>Desactivar</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
