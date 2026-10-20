import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi, fetchMedia } from '@/lib/api.js';

/**
 * Load one message's media as an object URL.
 *
 * Media is fetched with the owner-session cookie rather than placed in an
 * `<img src>` URL so errors are visible and the object URL can be revoked as
 * soon as the component unmounts. Nothing is cached in browser storage.
 */
export function useChatMedia(instanceId, chatId, messageId, { enabled = true } = {}) {
  const [state, setState] = useState({ status: 'idle', url: null, blob: null, mimeType: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const urlRef = useRef(null);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !instanceId || !chatId || !messageId) {
      // Avoid a needless render for the many text-only bubbles on the page.
      setState((previous) =>
        previous.status === 'idle'
          ? previous
          : { status: 'idle', url: null, blob: null, mimeType: null, error: null },
      );
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState((previous) => ({ ...previous, status: 'loading', error: null }));

    (async () => {
      try {
        const result = await fetchMedia(chatApi.mediaPath(instanceId, chatId, messageId), {
          signal: controller.signal,
        });
        if (cancelled) return;
        revoke();
        const url = URL.createObjectURL(result.blob);
        urlRef.current = url;
        setState({
          status: 'ready',
          url,
          blob: result.blob,
          mimeType: result.mimeType,
          disposition: result.disposition,
          error: null,
        });
      } catch (error) {
        if (cancelled || error?.code === 'NETWORK_ERROR') {
          // An aborted request is normal when the user switches chats.
          if (cancelled) return;
        }
        setState({
          status: 'error',
          url: null,
          blob: null,
          mimeType: null,
          error: error?.message ?? 'This media could not be loaded.',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      revoke();
    };
  }, [instanceId, chatId, messageId, enabled, reloadKey, revoke]);

  return {
    ...state,
    reload: () => setReloadKey((value) => value + 1),
  };
}
