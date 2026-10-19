import { useEffect } from 'react';

function useDocumentTitle(title) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.title;
    document.title = title ? `${title} · ww2web` : 'ww2web';
    return () => {
      document.title = previous;
    };
  }, [title]);
}

export { useDocumentTitle };
