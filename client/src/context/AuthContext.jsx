import { createContext, useContext, useEffect, useRef, useState } from 'react';
import api from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const refreshState = useRef({
    inFlight: null,
    lastCompletedAt: 0
  });

  const refreshUser = async (options = {}) => {
    const { force = false, minIntervalMs = 30000 } = options;

    if (!force && refreshState.current.inFlight) {
      return refreshState.current.inFlight;
    }

    if (
      !force &&
      refreshState.current.lastCompletedAt > 0 &&
      Date.now() - refreshState.current.lastCompletedAt < minIntervalMs
    ) {
      return user;
    }

    const request = api.get('/auth/check')
      .then((res) => {
        if (res.data.authenticated) {
          setUser(res.data.user);
          return res.data.user;
        }

        setUser(null);
        return null;
      })
      .catch(() => user)
      .finally(() => {
        refreshState.current.inFlight = null;
        refreshState.current.lastCompletedAt = Date.now();
        setLoading(false);
      });

    refreshState.current.inFlight = request;
    return request;
  };

  useEffect(() => {
    void refreshUser({ force: true });
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    setUser(res.data.user);
    refreshState.current.lastCompletedAt = Date.now();
    return res.data;
  };

  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
    refreshState.current.lastCompletedAt = 0;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
