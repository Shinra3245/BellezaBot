import { useAuth } from './auth/AuthContext';
import { Redirect, useRouter } from './routing/Router';
import Layout from './components/Layout';
import Login from './pages/Login';
import Calendar from './pages/Calendar';
import Services from './pages/Services';
import Schedule from './pages/Schedule';
import BotConfig from './pages/BotConfig';
import Tenants from './pages/admin/Tenants';

const OWNER_PAGES = {
  '/calendar': Calendar,
  '/services': Services,
  '/schedule': Schedule,
  '/bot': BotConfig,
};

const ADMIN_PAGES = { '/tenants': Tenants };

export default function App() {
  const { user } = useAuth();
  const { pathname } = useRouter();

  if (!user) return pathname === '/login' ? <Login /> : <Redirect to="/login" />;

  const home = user.role === 'superadmin' ? '/tenants' : '/calendar';
  if (pathname === '/' || pathname === '/login') return <Redirect to={home} />;

  const pages = user.role === 'superadmin' ? ADMIN_PAGES : OWNER_PAGES;
  const Page = pages[pathname];
  if (!Page) return <Redirect to={home} />;

  return (
    <Layout>
      <Page />
    </Layout>
  );
}
