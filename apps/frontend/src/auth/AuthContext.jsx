import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../api/client';

const AuthContext = createContext(null);

// Decodifica el payload de un JWT sin verificar firma (solo para leer role/businessId en el cliente).
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const t = getToken();
    if (!t) return null;
    const p = decodeJwt(t);
    return p ? { userId: p.userId, businessId: p.businessId, role: p.role } : null;
  });

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  // Cualquier 401 del backend cierra la sesión.
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  async function login(email, password) {
    const { token, user: u } = await api.post('/auth/login', { email, password });
    setToken(token);
    const p = decodeJwt(token);
    setUser({ userId: u.id, businessId: p?.businessId ?? u.business_id, role: u.role });
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
