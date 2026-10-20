import { useCallback, useEffect, useRef, useState } from 'react';

const PREFERRED_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

const MAX_SECONDS = 300;

function chooseMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return '';
}

function permissionMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Microphone access was refused. Allow it in the browser, then try again.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'No microphone was found on this device.';
  }
  return 'The microphone could not be started.';
}

/**
 * Browser voice-note recorder.
 *
 * The browser records Opus in WebM/Ogg; the exact container is reported to the
 * server, which sends those bytes as a WhatsApp voice note. WhatsApp may
 * transcode or reject a container it does not accept — that error is surfaced,
 * never hidden.
 */
export function useVoiceRecorder() {
  const supported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  const [state, setState] = useState('idle'); // idle | recording | processing
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const resolveRef = useRef(null);
  const cancelledRef = useRef(false);
  const stopRef = useRef(null);
  const secondsRef = useRef(0);

  const cleanupStream = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    for (const track of streamRef.current?.getTracks?.() ?? []) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* recorder may have already stopped */
      }
    }
    cleanupStream();
    chunksRef.current = [];
    resolveRef.current = null;
    secondsRef.current = 0;
    setState('idle');
    setSeconds(0);
    setError(null);
  }, [cleanupStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      return Promise.resolve(null);
    }
    setState('processing');
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      try {
        recorder.stop();
      } catch {
        cleanupStream();
        setState('idle');
        resolve(null);
      }
    });
  }, [cleanupStream]);

  stopRef.current = stop;

  const start = useCallback(async () => {
    if (!supported) {
      setError('This browser cannot record audio. Choose an audio file instead.');
      return false;
    }
    setError(null);
    secondsRef.current = 0;
    setSeconds(0);
    cancelledRef.current = false;
    chunksRef.current = [];
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (caught) {
      setError(permissionMessage(caught));
      setState('idle');
      return false;
    }
    streamRef.current = stream;
    const mimeType = chooseMimeType();
    let recorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch (caught) {
        cleanupStream();
        setError('This browser could not start the recorder.');
        setState('idle');
        return false;
      }
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const chunks = chunksRef.current;
      chunksRef.current = [];
      const cancelled = cancelledRef.current;
      const type = recorder.mimeType || mimeType || 'audio/webm';
      cleanupStream();
      setState('idle');
      if (cancelled) {
        resolveRef.current?.(null);
        resolveRef.current = null;
        return;
      }
      const blob = new Blob(chunks, { type });
      const result = blob.size > 0 ? { blob, mimeType: type, seconds: secondsRef.current } : null;
      resolveRef.current?.(result);
      resolveRef.current = null;
    };
    recorder.onerror = () => {
      setError('The recorder stopped unexpectedly.');
      cleanupStream();
      setState('idle');
      resolveRef.current?.(null);
      resolveRef.current = null;
    };
    recorder.start(250);
    setState('recording');
    timerRef.current = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
      if (secondsRef.current >= MAX_SECONDS) {
        stopRef.current?.();
      }
    }, 1000);
    return true;
  }, [cleanupStream, supported]);

  useEffect(() => () => cancel(), [cancel]);

  return {
    supported,
    state,
    seconds,
    error,
    start,
    stop,
    cancel,
    clearError: () => setError(null),
    maxSeconds: MAX_SECONDS,
  };
}
