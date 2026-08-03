import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

const STATUS_LABEL = {
  pending: 'Pendiente', confirmed: 'Confirmada', rescheduled: 'Reprogramada',
  cancelled: 'Cancelada', completed: 'Completada', no_show: 'No asistió',
};

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}
// Lunes de la semana que contiene dateStr.
function startOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00');
  const dow = (d.getDay() + 6) % 7; // 0 = lunes
  d.setDate(d.getDate() - dow);
  return ymd(d);
}

export default function Calendar() {
  const [date, setDate] = useState(ymd(new Date()));
  const [view, setView] = useState('day');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const range = view === 'day'
    ? { from: date, to: date }
    : { from: startOfWeek(date), to: addDays(startOfWeek(date), 6) };

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { appointments } = await api.get(`/panel/appointments?from=${range.from}&to=${range.to}`);
      setItems(appointments);
    } catch (e) {
      setError('No se pudieron cargar las citas');
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(id, status) {
    await api.patch(`/panel/appointments/${id}`, { status });
    load();
  }
  async function reschedule(id, isoLocal) {
    if (!isoLocal) return;
    try {
      await api.patch(`/panel/appointments/${id}`, { starts_at: new Date(isoLocal).toISOString() });
      load();
    } catch (e) {
      alert(e.status === 409 ? 'Ese horario no está disponible' : 'No se pudo reprogramar');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Agenda</h2>
        <div className="seg">
          <button className={view === 'day' ? 'seg-on' : ''} onClick={() => setView('day')}>Día</button>
          <button className={view === 'week' ? 'seg-on' : ''} onClick={() => setView('week')}>Semana</button>
        </div>
      </div>

      <div className="row gap">
        <button className="btn-ghost" onClick={() => setDate(addDays(date, view === 'day' ? -1 : -7))}>‹</button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn-ghost" onClick={() => setDate(addDays(date, view === 'day' ? 1 : 7))}>›</button>
      </div>

      {loading && <p className="muted">Cargando…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && items.length === 0 && <p className="muted">Sin citas en este periodo.</p>}

      <ul className="list">
        {items.map((a) => (
          <AppointmentCard key={a.id} appt={a} onStatus={setStatus} onReschedule={reschedule} />
        ))}
      </ul>
    </div>
  );
}

function AppointmentCard({ appt, onStatus, onReschedule }) {
  const [open, setOpen] = useState(false);
  const [newDt, setNewDt] = useState('');
  const dt = new Date(appt.starts_at);
  const when = dt.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const done = appt.status === 'cancelled' || appt.status === 'completed';

  return (
    <li className={`card status-${appt.status}`}>
      <div className="card-main">
        <strong>{appt.client_name || 'Clienta'}</strong>
        <span className="muted">{appt.service_name}</span>
        <span className="when">{when}</span>
        <span className={`badge badge-${appt.status}`}>{STATUS_LABEL[appt.status] || appt.status}</span>
      </div>
      {!done && (
        <div className="card-actions">
          <button onClick={() => onStatus(appt.id, 'completed')}>✓ Completada</button>
          <button onClick={() => onStatus(appt.id, 'no_show')}>✗ No asistió</button>
          <button onClick={() => onStatus(appt.id, 'cancelled')}>Cancelar</button>
          <button onClick={() => setOpen((v) => !v)}>Reprogramar</button>
        </div>
      )}
      {open && (
        <div className="row gap reschedule">
          <input type="datetime-local" value={newDt} onChange={(e) => setNewDt(e.target.value)} />
          <button className="btn-primary sm" onClick={() => onReschedule(appt.id, newDt)}>Guardar</button>
        </div>
      )}
    </li>
  );
}
