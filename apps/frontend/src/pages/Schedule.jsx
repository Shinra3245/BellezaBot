import { useEffect, useState } from 'react';
import { api } from '../api/client';

// 0 = Domingo … 6 = Sábado (convención de la BD / JS Date.getDay()).
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export default function Schedule() {
  const [schedules, setSchedules] = useState([]);
  const [form, setForm] = useState({ day_of_week: '1', start_time: '10:00', end_time: '19:00' });
  const [error, setError] = useState('');

  async function load() {
    const { schedules } = await api.get('/panel/schedules');
    setSchedules(schedules);
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    if (form.end_time <= form.start_time) { setError('La hora de fin debe ser mayor a la de inicio'); return; }
    try {
      await api.post('/panel/schedules', {
        day_of_week: Number(form.day_of_week),
        start_time: form.start_time,
        end_time: form.end_time,
      });
      load();
    } catch {
      setError('No se pudo agregar el horario');
    }
  }
  async function remove(id) {
    await api.del(`/panel/schedules/${id}`);
    load();
  }

  const byDay = DAYS.map((_, d) => schedules.filter((s) => s.day_of_week === d));

  return (
    <div className="page">
      <h2>Horarios de atención</h2>

      <form className="card form" onSubmit={create}>
        <select value={form.day_of_week} onChange={(e) => setForm({ ...form, day_of_week: e.target.value })}>
          {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
        </select>
        <div className="row gap">
          <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} required />
          <span className="muted">a</span>
          <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} required />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn-primary" type="submit">Agregar horario</button>
      </form>

      <div className="list">
        {DAYS.map((day, d) => (
          <div key={d} className="card">
            <div className="card-main"><strong>{day}</strong></div>
            {byDay[d].length === 0 ? (
              <span className="muted">Cerrado</span>
            ) : (
              <ul className="chips">
                {byDay[d].map((s) => (
                  <li key={s.id} className="chip">
                    {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                    <button className="chip-x" onClick={() => remove(s.id)}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
