import { useAuth } from '../auth/AuthContext';
import { InternalLink } from '../routing/Router';

// Navegación mobile-first: barra inferior de pestañas (como una app nativa).
const ownerTabs = [
  { to: '/calendar', label: 'Agenda', icon: '📅' },
  { to: '/services', label: 'Servicios', icon: '💅' },
  { to: '/schedule', label: 'Horarios', icon: '🕒' },
  { to: '/bot', label: 'Bot', icon: '🤖' },
];
const adminTabs = [{ to: '/tenants', label: 'Negocios', icon: '🏪' }];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const tabs = user?.role === 'superadmin' ? adminTabs : ownerTabs;

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand">BellezaBot</span>
        <button className="link-btn" onClick={logout}>Salir</button>
      </header>

      <main className="app-main">
        {children}
      </main>

      <nav className="tabbar">
        {tabs.map((t) => (
          <InternalLink key={t.to} to={t.to} className={({ isActive }) => 'tab' + (isActive ? ' tab-active' : '')}>
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </InternalLink>
        ))}
      </nav>
    </div>
  );
}
