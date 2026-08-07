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

function dateInputValue(iso, timezone) {
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export default function Calendar() {
  const [date, setDate] = useState(ymd(new Date()));
  const [view, setView] = useState('day');
  const [items, setItems] = useState([]);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const range = view === 'day'
    ? { from: date, to: date }
    : { from: startOfWeek(date), to: addDays(startOfWeek(date), 6) };

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api.get(`/panel/appointments?from=${range.from}&to=${range.to}`);
      setItems(result.appointments);
      if (result.timezone) setTimezone(result.timezone);
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
  async function reschedule(id, datetimeIso) {
    await api.patch(`/panel/appointments/${id}`, { starts_at: datetimeIso });
    await load();
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
        {items.map((appointment) => (
          <AppointmentCard
            key={appointment.id}
            appointment={appointment}
            timezone={timezone}
            onStatus={setStatus}
            onReschedule={reschedule}
          />
        ))}
      </ul>
    </div>
  );
}

function AppointmentCard({ appointment, timezone, onStatus, onReschedule }) {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState('');
  const [availability, setAvailability] = useState(null);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const startsAt = new Date(appointment.starts_at);
  const when = startsAt.toLocaleString('es-MX', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const done = appointment.status === 'cancelled' || appointment.status === 'completed';

  useEffect(() => {
    if (!isEditorOpen || !selectedDate) return undefined;

    let isCurrentRequest = true;
    setIsLoadingSlots(true);
    setSelectedSlot('');
    setError('');

    api.get(`/panel/appointments/${appointment.id}/availability?date=${encodeURIComponent(selectedDate)}`)
      .then((result) => {
        if (isCurrentRequest) setAvailability(result);
      })
      .catch(() => {
        if (isCurrentRequest) {
          setAvailability(null);
          setError('No se pudieron consultar los horarios. Intenta nuevamente.');
        }
      })
      .finally(() => {
        if (isCurrentRequest) setIsLoadingSlots(false);
      });

    return () => { isCurrentRequest = false; };
  }, [appointment.id, isEditorOpen, refreshKey, selectedDate]);

  function toggleEditor() {
    if (isEditorOpen) {
      setIsEditorOpen(false);
      return;
    }
    setSelectedDate(dateInputValue(appointment.starts_at, timezone));
    setSelectedSlot('');
    setAvailability(null);
    setError('');
    setIsEditorOpen(true);
  }

  async function saveReschedule() {
    if (!selectedSlot) return;
    setIsSaving(true);
    setError('');
    try {
      await onReschedule(appointment.id, selectedSlot);
      setIsEditorOpen(false);
    } catch (requestError) {
      if (requestError.status === 409) {
        setError('Ese horario acaba de ocuparse. Elige otro horario disponible.');
        setRefreshKey((value) => value + 1);
      } else {
        setError('No se pudo reprogramar la cita. Intenta nuevamente.');
      }
    } finally {
      setIsSaving(false);
    }
  }

  const availabilityHint = getAvailabilityHint(availability, isLoadingSlots);

  return (
    <li className={`card status-${appointment.status}`}>
      <div className="card-main">
        <strong>{appointment.client_name || 'Clienta'}</strong>
        <span className="muted">{appointment.service_name}</span>
        <span className="when">{when}</span>
        <span className={`badge badge-${appointment.status}`}>{STATUS_LABEL[appointment.status] || appointment.status}</span>
      </div>
      {!done && (
        <div className="card-actions">
          <button onClick={() => onStatus(appointment.id, 'completed')}>✓ Completada</button>
          <button onClick={() => onStatus(appointment.id, 'no_show')}>✗ No asistió</button>
          <button onClick={() => onStatus(appointment.id, 'cancelled')}>Cancelar</button>
          <button aria-expanded={isEditorOpen} onClick={toggleEditor}>
            {isEditorOpen ? 'Cerrar' : 'Reprogramar'}
          </button>
        </div>
      )}
      {isEditorOpen && (
        <div className="reschedule-form">
          <div className="reschedule-fields">
            <label>
              Nueva fecha
              <input
                type="date"
                value={selectedDate}
                min={availability?.min_date}
                max={availability?.max_date}
                onChange={(event) => setSelectedDate(event.target.value)}
              />
            </label>
            <label>
              Hora disponible
              <select
                value={selectedSlot}
                disabled={isLoadingSlots || !availability?.slots?.length}
                onChange={(event) => setSelectedSlot(event.target.value)}
              >
                <option value="">
                  {isLoadingSlots ? 'Consultando horarios…' : 'Selecciona una hora'}
                </option>
                {availability?.slots?.map((slot) => (
                  <option key={slot.datetime_iso} value={slot.datetime_iso}>{slot.label}</option>
                ))}
              </select>
            </label>
          </div>
          {availabilityHint && <p className="muted reschedule-hint" aria-live="polite">{availabilityHint}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <button
            className="btn-primary sm reschedule-save"
            disabled={!selectedSlot || isLoadingSlots || isSaving}
            onClick={saveReschedule}
          >
            {isSaving ? 'Guardando…' : 'Guardar reprogramación'}
          </button>
        </div>
      )}
    </li>
  );
}

function getAvailabilityHint(availability, isLoading) {
  if (isLoading) return 'Buscando horarios que respeten la duración del servicio…';
  if (!availability) return '';
  if (availability.past) return 'Elige una fecha actual o futura.';
  if (availability.tooFar) return `Solo puedes reprogramar hasta el ${availability.max_date}.`;
  if (availability.closed) return 'El negocio no atiende en esta fecha.';
  if (availability.slots.length === 0) return 'No quedan horarios disponibles para esta fecha.';
  const count = availability.slots.length;
  return `${count} ${count === 1 ? 'horario disponible' : 'horarios disponibles'} · Duración: ${availability.duration_minutes} min`;
}
