import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, setCsrfToken, setUnauthorizedHandler } from '@/lib/api.js';

const AuthContext = createContext(null);

const ANONYMOUS = Object.freeze({ status: 'anonymous', owner: null, expiresAt: null });

/**
 * Owner session state.
 *
 * The session itself lives in an HttpOnly cookie the JavaScript can never read.
 * All this context holds is the owner's public metadata and — in memory only —
 * the CSRF token required for state-changing requests. Nothing is written to
 * localStorage: a page reload re-validates the session against the server.
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', owner: null, expiresAt: null });

  const becomeAnonymous = useCallback(() => {
    setCsrfToken(null);
    setState(ANONYMOUS);
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const { data } = await authApi.session();
      setCsrfToken(data.csrfToken);
      setState({ status: 'authenticated', owner: data.owner, expiresAt: data.expiresAt });
      return data;
    } catch {
      becomeAnonymous();
      return null;
    }
  }, [becomeAnonymous]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await authApi.session();
        if (cancelled) return;
        setCsrfToken(data.csrfToken);
        setState({ status: 'authenticated', owner: data.owner, expiresAt: data.expiresAt });
      } catch {
        if (!cancelled) becomeAnonymous();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [becomeAnonymous]);

  // Any 401 from a protected call means the session is gone.
  useEffect(() => {
    setUnauthorizedHandler(becomeAnonymous);
    return () => setUnauthorizedHandler(null);
  }, [becomeAnonymous]);

  const login = useCallback(async (apiKey) => {
    const { data } = await authApi.login(apiKey);
    setCsrfToken(data.csrfToken);
    setState({ status: 'authenticated', owner: data.owner, expiresAt: data.expiresAt });
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the session may already be gone; clearing locally is enough */
    } finally {
      becomeAnonymous();
    }
  }, [becomeAnonymous]);

  const value = useMemo(
    () => ({ ...state, isAuthenticated: state.status === 'authenticated', login, logout, refresh: loadSession }),
    [state, login, logout, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
