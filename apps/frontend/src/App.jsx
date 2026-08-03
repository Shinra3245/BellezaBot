import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Calendar from './pages/Calendar';
import Services from './pages/Services';
import Schedule from './pages/Schedule';
import BotConfig from './pages/BotConfig';
import Tenants from './pages/admin/Tenants';

// Restringe una ruta a usuarios autenticados (y opcionalmente a un rol).
function Protected({ children, role }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />

      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        {/* Home según el rol: la dueña ve su calendario; el super-admin, los negocios. */}
        <Route
          path="/"
          element={<Navigate to={user?.role === 'superadmin' ? '/tenants' : '/calendar'} replace />}
        />
        <Route path="/calendar" element={<Protected role="owner"><Calendar /></Protected>} />
        <Route path="/services" element={<Protected role="owner"><Services /></Protected>} />
        <Route path="/schedule" element={<Protected role="owner"><Schedule /></Protected>} />
        <Route path="/bot" element={<Protected role="owner"><BotConfig /></Protected>} />
        <Route path="/tenants" element={<Protected role="superadmin"><Tenants /></Protected>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
