import { useEffect, useState } from 'react';
import { api } from '../api/client';

// 0 = Domingo … 6 = Sábado (convención de la BD / JS Date.getDay()).
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export default function Schedule() {
  const [schedules, setSchedules] = useState([]);
  const [form, setForm] = useState({ day_of_week: '1', start_time: '10:00', end_time: '19:00' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  async function load() {
    try {
      const { schedules } = await api.get('/panel/schedules');
      setSchedules(schedules);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los horarios');
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (form.end_time <= form.start_time) {
      setError('La hora de fin debe ser mayor a la de inicio');
      return;
    }

    setCreating(true);
    try {
      const { schedule } = await api.post('/panel/schedules', {
        day_of_week: Number(form.day_of_week),
        start_time: form.start_time,
        end_time: form.end_time,
      });
      setSchedules((current) => [...current, schedule].sort(compareSchedules));
      setNotice('Horario agregado ✓');
    } catch (err) {
      setError(err.status === 409 ? 'Ese horario ya existe' : (err.message || 'No se pudo agregar el horario'));
    } finally {
      setCreating(false);
    }
  }

  async function remove(id) {
    if (deletingId) return;
    setError('');
    setNotice('');
    setDeletingId(id);
    try {
      await api.del(`/panel/schedules/${id}`);
      setSchedules((current) => current.filter((schedule) => schedule.id !== id));
      setNotice('Horario eliminado ✓');
    } catch (err) {
      if (err.status === 404) {
        await load();
        setNotice('El horario ya había sido eliminado');
      } else {
        setError(err.message || 'No se pudo eliminar el horario');
      }
    } finally {
      setDeletingId(null);
    }
  }

  const byDay = DAYS.map((_, day) => schedules.filter((schedule) => schedule.day_of_week === day));

  return (
    <div className="page">
      <h2>Horarios de atención</h2>

      <form className="card form" onSubmit={create}>
        <select value={form.day_of_week} onChange={(e) => setForm({ ...form, day_of_week: e.target.value })}>
          {DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select>
        <div className="row gap">
          <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} required />
          <span className="muted">a</span>
          <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} required />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="ok" role="status">{notice}</p>}
        <button className="btn-primary" type="submit" disabled={creating}>
          {creating ? 'Agregando…' : 'Agregar horario'}
        </button>
      </form>

      <div className="list">
        {DAYS.map((day, dayIndex) => (
          <div key={day} className="card">
            <div className="card-main"><strong>{day}</strong></div>
            {byDay[dayIndex].length === 0 ? (
              <span className="muted">Cerrado</span>
            ) : (
              <ul className="chips">
                {byDay[dayIndex].map((schedule) => (
                  <li key={schedule.id} className="chip">
                    {schedule.start_time.slice(0, 5)}–{schedule.end_time.slice(0, 5)}
                    <button
                      type="button"
                      className="chip-x"
                      onClick={() => remove(schedule.id)}
                      disabled={Boolean(deletingId)}
                      aria-label={`Eliminar horario ${schedule.start_time.slice(0, 5)} a ${schedule.end_time.slice(0, 5)}`}
                    >
                      {deletingId === schedule.id ? '…' : '×'}
                    </button>
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

function compareSchedules(a, b) {
  return a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time);
}
