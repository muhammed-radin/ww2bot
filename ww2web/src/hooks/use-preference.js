import { useCallback, useEffect, useState } from 'react';

/**
 * Persisted UI preference. Only non-sensitive presentation choices are stored
 * here; secrets, QR payloads and session tokens are never written to storage.
 */
export function usePreference(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage may be unavailable; the preference simply is not persisted */
    }
  }, [key, value]);

  const reset = useCallback(() => setValue(fallback), [fallback]);

  return [value, setValue, reset];
}
