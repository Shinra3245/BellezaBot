import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function Services() {
  const [services, setServices] = useState([]);
  const [form, setForm] = useState({ name: '', price: '', duration_minutes: '' });
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const { services } = await api.get('/panel/services');
      setServices(services);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los servicios');
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const { service } = await api.post('/panel/services', {
        name: form.name.trim(),
        price: Number(form.price),
        duration_minutes: Number(form.duration_minutes),
      });
      setServices((current) => [...current, service]);
      setForm({ name: '', price: '', duration_minutes: '' });
    } catch (err) {
      setError(err.message || 'No se pudo crear el servicio');
    } finally {
      setCreating(false);
    }
  }

  function replaceService(updated) {
    setServices((current) => current.map((service) => (
      service.id === updated.id ? { ...service, ...updated } : service
    )));
  }

  async function deactivate(service) {
    if (!confirm('¿Desactivar este servicio? Dejará de ofrecerse a las clientas.')) return;
    setError('');
    try {
      await api.del(`/panel/services/${service.id}`);
      replaceService({ ...service, is_active: false });
    } catch (err) {
      setError(err.message || 'No se pudo desactivar el servicio');
    }
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
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn-primary" type="submit" disabled={creating}>
          {creating ? 'Agregando…' : 'Agregar servicio'}
        </button>
      </form>

      <ul className="list">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            onSaved={replaceService}
            onDeactivate={deactivate}
          />
        ))}
      </ul>
    </div>
  );
}

function ServiceCard({ service, onSaved, onDeactivate }) {
  const [price, setPrice] = useState(String(Number(service.price)));
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');

  const numericPrice = Number(price);
  const valid = price !== '' && Number.isFinite(numericPrice) && numericPrice >= 0;
  const changed = valid && numericPrice !== Number(service.price);

  function changePrice(value) {
    setPrice(value);
    setStatus('idle');
    setMessage('');
  }

  async function savePrice() {
    if (!valid) {
      setStatus('error');
      setMessage('Ingresa un precio válido');
      return;
    }
    if (!changed || status === 'saving') return;

    setStatus('saving');
    setMessage('Guardando…');
    try {
      const { service: updated } = await api.patch(`/panel/services/${service.id}`, {
        price: numericPrice,
      });
      onSaved(updated);
      setPrice(String(Number(updated.price)));
      setStatus('saved');
      setMessage('Guardado ✓');
    } catch (err) {
      setStatus('error');
      setMessage(err.message || 'No se pudo guardar');
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      savePrice();
    }
  }

  return (
    <li className={`card ${service.is_active ? '' : 'inactive'}`}>
      <div className="card-main">
        <strong>{service.name}</strong>
        <span className="muted">{service.duration_minutes} min {service.is_active ? '' : '· (inactivo)'}</span>
      </div>
      <div className="card-actions service-actions">
        <div className="price-editor">
          <label className="inline-edit">
            <span className="sr-only">Precio de {service.name}</span>
            $<input
              type="number"
              min="0"
              step="1"
              value={price}
              onChange={(e) => changePrice(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!service.is_active || status === 'saving'}
            />
          </label>
          <button type="button" onClick={savePrice} disabled={!changed || status === 'saving'}>
            {status === 'saving' ? 'Guardando…' : 'Guardar precio'}
          </button>
        </div>
        {message && (
          <span className={status === 'error' ? 'error save-status' : 'ok save-status'} role={status === 'error' ? 'alert' : 'status'}>
            {message}
          </span>
        )}
        {service.is_active && (
          <button type="button" onClick={() => onDeactivate(service)}>Desactivar</button>
        )}
      </div>
    </li>
  );
}
