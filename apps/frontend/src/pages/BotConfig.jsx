import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function BotConfig() {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/panel/business').then(({ business }) => {
      setForm({
        name: business.name || '',
        bot_name: business.bot_name || '',
        bot_personality: business.bot_personality || '',
        tone: business.tone || '',
        owner_phone: business.owner_phone || '',
      });
    });
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaved(false); setError('');
    try {
      await api.patch('/panel/business', form);
      setSaved(true);
    } catch {
      setError('No se pudo guardar');
    }
  }

  if (!form) return <div className="page"><p className="muted">Cargando…</p></div>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page">
      <h2>Configuración del bot</h2>
      <form className="card form" onSubmit={save}>
        <label>Nombre del negocio
          <input value={form.name} onChange={set('name')} />
        </label>
        <label>Nombre del bot
          <input value={form.bot_name} onChange={set('bot_name')} placeholder="ej. Bella" />
        </label>
        <label>Personalidad
          <input value={form.bot_personality} onChange={set('bot_personality')} placeholder="ej. amable y cercana" />
        </label>
        <label>Tono
          <select value={form.tone} onChange={set('tone')}>
            <option value="informal">Informal</option>
            <option value="formal">Formal</option>
            <option value="divertido">Divertido</option>
          </select>
        </label>
        <label>Tu número de WhatsApp (activa el modo admin por chat)
          <input value={form.owner_phone} onChange={set('owner_phone')} placeholder="+52..." />
          <small className="muted">Desde este número podrás administrar tu agenda por WhatsApp.</small>
        </label>
        {error && <p className="error">{error}</p>}
        {saved && <p className="ok">Guardado ✓</p>}
        <button className="btn-primary" type="submit">Guardar cambios</button>
      </form>
    </div>
  );
}
