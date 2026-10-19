import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePreference } from '@/hooks/use-preference.js';
import { uiApi } from '@/lib/api.js';

const StatusContext = createContext(null);

/** Refresh cadence for the shared snapshot, adjustable from Settings. */
export const REFRESH_INTERVAL_KEY = 'ww2web.refreshIntervalMs';
export const REFRESH_INTERVAL_OPTIONS = [
  { value: 10000, label: 'Every 10 seconds' },
  { value: 15000, label: 'Every 15 seconds' },
  { value: 30000, label: 'Every 30 seconds' },
  { value: 60000, label: 'Every minute' },
];

/**
 * Shared service status for the shell: the sidebar connection indicator and the
 * dashboard both read the same snapshot, so the header never disagrees with the
 * page. The snapshot comes straight from `/api/v1/ui/overview`.
 */
export function StatusProvider({ children }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshInterval] = usePreference(REFRESH_INTERVAL_KEY, 15000);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await uiApi.overview();
      setOverview(data);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await uiApi.overview();
        if (!cancelled) {
          setOverview(data);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => load({ silent: true }), refreshInterval);
    return () => clearInterval(id);
  }, [load, refreshInterval]);

  const value = useMemo(() => ({ overview, error, loading, reload: load }), [overview, error, loading, load]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useStatus() {
  const context = useContext(StatusContext);
  if (!context) throw new Error('useStatus must be used within a StatusProvider');
  return context;
}
