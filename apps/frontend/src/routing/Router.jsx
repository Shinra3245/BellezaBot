import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const RouterContext = createContext(null);

function currentPath() {
  return window.location.pathname || '/';
}

// Enrutador mínimo para las rutas estáticas del panel. Solo permite navegación
// dentro del mismo origen y conserva soporte para atrás/adelante del navegador.
export function RouterProvider({ children }) {
  const [pathname, setPathname] = useState(currentPath);

  useEffect(() => {
    const onPopState = () => setPathname(currentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((target, { replace = false } = {}) => {
    const destination = new URL(target, window.location.origin);
    if (destination.origin !== window.location.origin) return;

    const next = `${destination.pathname}${destination.search}${destination.hash}`;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', next);
    setPathname(destination.pathname || '/');
  }, []);

  const value = useMemo(() => ({ pathname, navigate }), [pathname, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const router = useContext(RouterContext);
  if (!router) throw new Error('useRouter debe utilizarse dentro de RouterProvider');
  return router;
}

export function Redirect({ to }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace: true }), [navigate, to]);
  return null;
}

export function InternalLink({ to, className, children }) {
  const { pathname, navigate } = useRouter();
  const active = pathname === to;
  const resolvedClassName = typeof className === 'function' ? className({ isActive: active }) : className;

  function onClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) return;
    event.preventDefault();
    navigate(to);
  }

  return (
    <a href={to} className={resolvedClassName} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {children}
    </a>
  );
}
