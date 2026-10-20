import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small data-fetching hook with explicit loading / refetching / error state.
 *
 * `fetcher` is read through a ref, so an inline arrow function does not cause a
 * refetch; pass a `deps` array to control when the request is (re)issued. The
 * optional `pollMs` re-runs the fetcher silently on an interval.
 */
export function useApi(fetcher, deps = [], { immediate = true, pollMs = 0 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(immediate));
  const [refetching, setRefetching] = useState(false);

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefetching(true);
    else setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (!mountedRef.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefetching(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!immediate) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    // A dependency change starts a new request; an error from the previous
    // instance/query must not linger while the new one is in flight.
    setError(null);
    (async () => {
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!pollMs || !immediate) return undefined;
    const id = setInterval(() => load({ silent: true }), pollMs);
    return () => clearInterval(id);
  }, [pollMs, immediate, load]);

  return { data, error, loading, refetching, reload: load, setData };
}
