import { useEffect, useRef, useState } from 'react';
import { instancesApi } from '@/lib/api.js';

const NAMED_EVENTS = [
  'stream.ready',
  'stream.closed',
  'connection.status',
  'connection.state',
  'auth.qr',
  'auth.qr_expired',
  'auth.pairing_code',
  'auth.loading',
  'auth.state',
  'connection.authenticated',
  'connection.disconnected',
  'connection.reconnecting',
  'connection.error',
  'message.received',
  'message.sent',
  'connector.metric',
];

/**
 * Strip short-lived authentication credentials from streamed events before they
 * are held anywhere in the UI. The QR payload and pairing code are surfaced
 * through dedicated fields and are never written to storage or a log.
 */
function stripSecrets(type, data) {
  if (!data || typeof data !== 'object') return data ?? {};
  if (type === 'auth.qr') {
    const { qrDataUrl, ...rest } = data;
    return rest;
  }
  if (type === 'auth.pairing_code') {
    const { pairingCode, ...rest } = data;
    return rest;
  }
  return data;
}

/**
 * Live WhatsApp authentication / connection events for one instance.
 *
 * The owner session cookie authorises the stream directly, so no stream token
 * is needed in the browser. The EventSource is closed when the instance changes
 * or the component unmounts, which also drops any in-memory QR payload.
 */
export function useConnectionEvents(instanceId, { enabled = true } = {}) {
  const [events, setEvents] = useState([]);
  const [lastEvent, setLastEvent] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [streamState, setStreamState] = useState('idle');
  const sourceRef = useRef(null);

  useEffect(() => {
    setEvents([]);
    setLastEvent(null);
    setSnapshot(null);
    if (!enabled || !instanceId) {
      setStreamState('idle');
      return undefined;
    }

    let source;
    setStreamState('connecting');
    try {
      source = new EventSource(instancesApi.eventsUrl(instanceId), { withCredentials: true });
    } catch {
      setStreamState('error');
      return undefined;
    }
    sourceRef.current = source;

    const handle = (event) => {
      let payload = {};
      try {
        payload = event.data ? JSON.parse(event.data) : {};
      } catch {
        payload = {};
      }
      const record = {
        key: event.lastEventId || `${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: event.type,
        data: stripSecrets(event.type, payload),
        at: new Date().toISOString(),
      };
      if (event.type === 'stream.ready') setSnapshot(payload.snapshot ?? null);
      setLastEvent({ ...record, raw: payload });
      setEvents((previous) => [record, ...previous].slice(0, 50));
    };

    for (const name of NAMED_EVENTS) source.addEventListener(name, handle);
    source.onopen = () => setStreamState('open');
    source.onerror = () => setStreamState('error');

    return () => {
      for (const name of NAMED_EVENTS) source.removeEventListener?.(name, handle);
      source.close();
      sourceRef.current = null;
      // Dropping the references clears any credential material from memory.
      setLastEvent(null);
      setEvents([]);
      setSnapshot(null);
    };
  }, [instanceId, enabled]);

  return { events, lastEvent, streamState, snapshot };
}
