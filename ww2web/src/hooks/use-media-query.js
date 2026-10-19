import { useEffect, useState } from 'react';

/** Subscribe to a CSS media query from React. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = (event) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** True below the Tailwind `lg` breakpoint, where the sidebar collapses. */
export function useIsMobile() {
  return useMediaQuery('(max-width: 1023px)');
}
