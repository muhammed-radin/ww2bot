import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  DownloadCloud,
  KeyRound,
  Link2,
  Loader2,
  PlugZap,
  QrCode,
  RefreshCw,
  Server,
  Smartphone,
  Timer,
  Trash2,
  Unplug,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Separator } from '@/components/ui/separator.jsx';
import { Switch } from '@/components/ui/switch.jsx';
import { ConfirmDialog } from '@/components/common/confirm-dialog.jsx';
import { CopyButton } from '@/components/common/copy-button.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { LiveDot, StatusBadge } from '@/components/common/status-badge.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useConnectionEvents } from '@/hooks/use-connection-events.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { instancesApi } from '@/lib/api.js';
import { formatDateTime, formatRelative, shortId, titleCase } from '@/lib/format.js';

const STREAM_LABELS = {
  idle: { label: 'Idle', tone: 'muted' },
  connecting: { label: 'Connecting', tone: 'warning' },
  open: { label: 'Live', tone: 'success' },
  error: { label: 'Reconnecting', tone: 'warning' },
};

const EVENT_LABELS = {
  'stream.ready': 'Stream ready',
  'stream.closed': 'Stream closed',
  'connection.status': 'Status changed',
  'connection.state': 'State changed',
  'auth.qr': 'QR code issued',
  'auth.qr_expired': 'QR code expired',
  'auth.pairing_code': 'Pairing code issued',
  'auth.loading': 'Syncing chats',
  'auth.state': 'WhatsApp state',
  'connection.authenticated': 'Authenticated',
  'connection.disconnected': 'Disconnected',
  'connection.reconnecting': 'Reconnecting',
  'connection.error': 'Connection error',
  'message.received': 'Message received',
  'connector.metric': 'Connector metric',
};

const SESSION_STEPS = [
  { key: 'starting', label: 'Start browser' },
  { key: 'qr', label: 'QR issued' },
  { key: 'authenticating', label: 'Device linked' },
  { key: 'syncing', label: 'Sync chats' },
  { key: 'ready', label: 'Ready' },
];

function secondsUntil(expiresAt, now) {
  if (!expiresAt) return null;
  const delta = new Date(expiresAt).getTime() - now;
  return delta > 0 ? Math.ceil(delta / 1000) : 0;
}

export default function ConnectionPage() {
  useDocumentTitle('Connection');

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);
  const instances = instancesQuery.data?.data?.items ?? [];

  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (instances.length === 0) {
      if (selectedId) setSelectedId(null);
      return;
    }
    if (!selectedId || !instances.some((item) => item.id === selectedId)) setSelectedId(instances[0].id);
  }, [instances, selectedId]);

  const selected = useMemo(() => instances.find((item) => item.id === selectedId) ?? null, [instances, selectedId]);

  const statusQuery = useApi(() => instancesApi.status(selectedId), [selectedId], {
    immediate: Boolean(selectedId),
    pollMs: selectedId ? 5000 : 0,
  });
  const capabilitiesQuery = useApi(() => instancesApi.capabilities(selectedId), [selectedId], {
    immediate: Boolean(selectedId),
  });
  const sessionQuery = useApi(() => instancesApi.session(selectedId), [selectedId], { immediate: Boolean(selectedId) });

  const { events, lastEvent, streamState, snapshot } = useConnectionEvents(selectedId, { enabled: Boolean(selectedId) });

  const status = statusQuery.data?.data ?? snapshot ?? null;
  const capabilities = capabilitiesQuery.data?.data?.capabilities ?? null;
  const session = sessionQuery.data?.data?.session ?? null;

  const [qr, setQr] = useState(null);
  const [qrRefreshing, setQrRefreshing] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [busy, setBusy] = useState(null);
  const [liveLoading, setLiveLoading] = useState(null);
  const [authState, setAuthState] = useState(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [logoutOnDisconnect, setLogoutOnDisconnect] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [startedAt, setStartedAt] = useState(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Drop short-lived QR / pairing material the moment the instance changes.
  useEffect(() => {
    setQr(null);
    setPairing(null);
    setLiveLoading(null);
    setAuthState(null);
    setQrRefreshing(false);
    setStartedAt(Date.now());
    return () => {
      setQr(null);
      setPairing(null);
      setLiveLoading(null);
      setAuthState(null);
      setQrRefreshing(false);
    };
  }, [selectedId]);

  // Refresh the QR from the polled status when the connector reports one.
  const statusQr = status?.qr ?? null;
  useEffect(() => {
    if (!statusQr?.qrDataUrl) return;
    setQrRefreshing(false);
    setQr((current) => (current?.qrDataUrl === statusQr.qrDataUrl ? current : { qrDataUrl: statusQr.qrDataUrl, expiresAt: statusQr.expiresAt }));
  }, [statusQr?.qrDataUrl, statusQr?.expiresAt]);

  // Live stream events take precedence over polling.
  useEffect(() => {
    if (!lastEvent) return;
    const { type, raw } = lastEvent;
    if (type === 'auth.qr' && raw?.qrDataUrl) {
      setQrRefreshing(false);
      setQr({ qrDataUrl: raw.qrDataUrl, expiresAt: raw.expiresAt ?? null });
    } else if (type === 'auth.qr_expired') {
      // Do not blank the image: WhatsApp rotates codes and a new auth.qr follows
      // shortly. Keep the last frame visible behind a "refreshing" overlay so an
      // expired code is never scanned and the panel never looks broken.
      setQrRefreshing(true);
    } else if (type === 'auth.pairing_code' && raw?.pairingCode) {
      setPairing({ pairingCode: raw.pairingCode, expiresAt: raw.expiresAt ?? null });
    } else if (type === 'auth.loading') {
      setLiveLoading({ percent: raw?.percent ?? null, message: raw?.message ?? null, complete: Boolean(raw?.complete), at: lastEvent.at });
    } else if (type === 'auth.state') {
      setAuthState(raw?.state ?? null);
    } else if (type === 'connection.authenticated' || (type === 'connection.status' && raw?.status === 'ready')) {
      setQr(null);
      setQrRefreshing(false);
      setPairing(null);
      if (type === 'connection.status' && raw?.details?.loading) setLiveLoading(raw.details.loading);
    } else if (type === 'connection.disconnected' || type === 'connection.error') {
      setLiveLoading(null);
      setAuthState(null);
      if (type === 'connection.disconnected') {
        setQr(null);
        setQrRefreshing(false);
        setPairing(null);
      }
    } else if (type === 'connection.status' && raw?.details?.loading) {
      setLiveLoading(raw.details.loading);
    }
  }, [lastEvent]);

  const qrSeconds = qr ? secondsUntil(qr.expiresAt, now) : null;
  const pairingSeconds = pairing ? secondsUntil(pairing.expiresAt, now) : null;

  // A QR is "stale" once its advertised lifetime has passed, whether or not the
  // connector has sent the expiry event yet.
  const qrStale = Boolean(qr) && qrSeconds === 0;
  useEffect(() => {
    if (pairing && pairingSeconds === 0) setPairing(null);
  }, [pairing, pairingSeconds]);

  async function startQr() {
    setBusy('qr');
    try {
      const { data } = await instancesApi.connectQr(selectedId);
      if (data.qr?.qrDataUrl) {
        setQrRefreshing(false);
        setQr({ qrDataUrl: data.qr.qrDataUrl, expiresAt: data.qr.expiresAt ?? null });
        toast.success('QR sign-in started', { description: 'Scan the code with WhatsApp on the phone.' });
      } else {
        // The browser is still starting. The QR arrives over SSE, so this is
        // informational, never an error.
        toast.info('QR sign-in started', {
          description: 'Waiting for WhatsApp to issue a code — it will appear here automatically.',
        });
      }
      statusQuery.reload({ silent: true });
    } catch (error) {
      // A slow first launch is not a failure: keep streaming and let the QR
      // arrive. Only genuine capability/configuration errors read as errors.
      if (error?.code === 'CONNECTOR_DISABLED' || error?.code === 'CAPABILITY_NOT_SUPPORTED') {
        toast.error('Could not start QR sign-in', { description: error.message });
      } else {
        toast.warning('Still starting the browser', {
          description: `${error.message} The session keeps streaming; the QR code will appear automatically when it is ready.`,
        });
      }
      statusQuery.reload({ silent: true });
    } finally {
      setBusy(null);
    }
  }

  async function requestPairingCode(event) {
    event.preventDefault();
    setBusy('pairing');
    try {
      const digits = phoneNumber.replace(/\D/g, '');
      const { data } = await instancesApi.connectPairingCode(selectedId, { phoneNumber: digits });
      if (data.pairingCode) setPairing({ pairingCode: data.pairingCode, expiresAt: data.expiresAt ?? null });
      toast.success('Pairing code ready', { description: 'Enter it on the phone under Linked devices.' });
      statusQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not request a pairing code', { description: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function confirmDisconnect() {
    setBusy('disconnect');
    try {
      const { data } = await instancesApi.disconnect(selectedId, { logout: logoutOnDisconnect });
      setQr(null);
      setQrRefreshing(false);
      setPairing(null);
      setLiveLoading(null);
      setAuthState(null);
      setDisconnectOpen(false);
      toast.success('Instance disconnected', { description: data.note });
      statusQuery.reload({ silent: true });
      sessionQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not disconnect the instance', { description: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function confirmRevoke() {
    setBusy('revoke');
    try {
      const { data } = await instancesApi.revokeSession(selectedId);
      setQr(null);
      setQrRefreshing(false);
      setPairing(null);
      setLiveLoading(null);
      setAuthState(null);
      setRevokeOpen(false);
      toast.success('Stored session revoked', {
        description:
          data.directoryRemoved || data.archiveRemoved
            ? 'The local browser profile and encrypted archive were deleted. Link the device again to reconnect.'
            : 'No stored session material remained. The instance is now disconnected.',
      });
      sessionQuery.reload({ silent: true });
      statusQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not revoke the stored session', { description: error.message });
    } finally {
      setBusy(null);
    }
  }

  /* ------------------------------------------------------------------ */
  /* session progress (streamed over SSE)                                */
  /* ------------------------------------------------------------------ */

  const loading = liveLoading ?? status?.details?.loading ?? null;
  const currentAuthState = authState ?? status?.details?.authState ?? null;
  const connectorStatus = status?.status ?? null;
  const connectionState = status?.connectionState ?? null;

  // One coarse phase, derived from the polled status and the live stream. The
  // server never reports a phase it has not actually reached.
  const phase = (() => {
    if (connectionState === 'ERROR' || connectorStatus === 'error') return 'error';
    if (connectionState === 'CONNECTED' || connectorStatus === 'ready') return 'ready';
    if (loading && (connectionState === 'AUTHENTICATING' || connectorStatus === 'authenticated')) return 'syncing';
    if (connectionState === 'AUTHENTICATING' || connectorStatus === 'authenticated') return 'authenticating';
    if (connectionState === 'QR_REQUIRED' || connectorStatus === 'awaiting_qr' || connectorStatus === 'awaiting_pairing_code') {
      return 'qr';
    }
    if (connectionState === 'INITIALIZING' || connectorStatus === 'initializing' || busy === 'qr') return 'starting';
    return 'idle';
  })();

  const activeStep = SESSION_STEPS.findIndex((step) => step.key === phase);
  const loadingPercent = typeof loading?.percent === 'number' ? loading.percent : null;
  const sessionError = phase === 'error' ? (status?.lastError ?? 'The connector reported an error.') : null;
  const qrStarting = busy === 'qr' || phase === 'starting' || (phase === 'qr' && !qr && !pairing);

  const streamMeta = STREAM_LABELS[streamState] ?? STREAM_LABELS.idle;
  const connectorLabels = { cloud_api: 'Official WhatsApp Cloud API', web: 'Authorised WhatsApp Web connector' };

  if (instancesQuery.loading && instances.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Connection" description="Sign in and monitor the WhatsApp connection." />
        <Card>
          <TableSkeleton rows={6} columns={3} />
        </Card>
      </div>
    );
  }

  if (instancesQuery.error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Connection" description="Sign in and monitor the WhatsApp connection." />
        <ErrorState error={instancesQuery.error} onRetry={instancesQuery.reload} title="Could not load instances" />
      </div>
    );
  }

  if (instances.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Connection" description="Sign in and monitor the WhatsApp connection." />
        <Card>
          <EmptyState
            icon={Server}
            title="No instances to connect"
            description="Create a WhatsApp instance first; the connection controls live here once one exists."
            action={
              <Button asChild size="sm">
                <Link to="/instances">Create an instance</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connection"
        description="Authenticate the WhatsApp session and follow its live state."
        actions={
          <Button variant="outline" size="sm" onClick={() => statusQuery.reload({ silent: true })} disabled={statusQuery.refetching}>
            <RefreshCw className={statusQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Instance</CardTitle>
          <CardDescription>Choose which WhatsApp instance to work with.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full space-y-2 sm:max-w-sm">
            <Label htmlFor="connection-instance">Instance</Label>
            <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
              <SelectTrigger id="connection-instance">
                <SelectValue placeholder="Select an instance" />
              </SelectTrigger>
              <SelectContent>
                {instances.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName || shortId(item.id)} · {titleCase(item.connector)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected ? (
            <div className="flex flex-wrap items-center gap-2 pb-1 text-xs text-muted-foreground">
              <Badge variant="muted">{connectorLabels[selected.connector] ?? titleCase(selected.connector)}</Badge>
              <span className="font-mono">{shortId(selected.id)}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle>Connection state</CardTitle>
            <CardDescription>
              {selected?.connector === 'web'
                ? 'Reported by the linked WhatsApp Web session.'
                : 'Reported by the official WhatsApp Cloud API credentials.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge kind="connection" status={status?.connectionState} />
            <Badge variant={streamMeta.tone}>
              <LiveDot active={streamState === 'open'} />
              {streamMeta.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {statusQuery.error && !status ? (
            <ErrorState error={statusQuery.error} onRetry={() => statusQuery.reload()} title="Could not read the connection status" />
          ) : (
            <>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Live process</dt>
                  <dd className="flex items-center gap-2 text-sm font-medium">
                    <LiveDot active={Boolean(status?.live)} />
                    {status?.live ? 'Running' : 'Not running'}
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Connector status</dt>
                  <dd className="text-sm font-medium">{titleCase(status?.status ?? selected?.status ?? 'unknown')}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Reconnect attempts</dt>
                  <dd className="text-sm font-medium tabular-nums">{status?.attempt ?? 0}</dd>
                </div>
                {status?.details?.linkedUser ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Linked account</dt>
                    <dd className="truncate text-sm font-medium">
                      {status.details.pushname ? `${status.details.pushname} · ` : ''}
                      {status.details.linkedUser}
                    </dd>
                  </div>
                ) : null}
                {status?.details?.platform ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Platform</dt>
                    <dd className="text-sm font-medium">{status.details.platform}</dd>
                  </div>
                ) : null}
                {status?.details?.authMode ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Authentication mode</dt>
                    <dd className="text-sm font-medium">{titleCase(status.details.authMode)}</dd>
                  </div>
                ) : null}
                {status?.nextAttemptAt ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Next reconnect</dt>
                    <dd className="text-sm font-medium">{formatRelative(status.nextAttemptAt)}</dd>
                  </div>
                ) : null}
              </dl>

              {status?.lastError ? (
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertTitle>Last error</AlertTitle>
                  <AlertDescription>{status.lastError}</AlertDescription>
                </Alert>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {selected?.connector === 'web' ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Authentication session</CardTitle>
              <CardDescription>
                Live progress streamed from the browser as it links and synchronises. Updates arrive over SSE, not by polling.
              </CardDescription>
            </div>
            <Badge variant={streamMeta.tone}>
              <LiveDot active={streamState === 'open'} />
              {streamMeta.label}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-5">
            <ol className="grid grid-cols-1 gap-3 sm:grid-cols-5">
              {SESSION_STEPS.map((step, index) => {
                const done = phase === 'ready' || (activeStep >= 0 && index < activeStep);
                const current = activeStep === index && phase !== 'ready';
                return (
                  <li key={step.key} className="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-2">
                    <span
                      className={
                        done
                          ? 'text-emerald-600 dark:text-emerald-500'
                          : current
                            ? 'text-amber-600 dark:text-amber-500'
                            : 'text-muted-foreground/50'
                      }
                    >
                      {done ? (
                        <CheckCircle2 className="size-4" aria-hidden="true" />
                      ) : current ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Circle className="size-4" aria-hidden="true" />
                      )}
                    </span>
                    <span
                      className={
                        done
                          ? 'text-sm font-medium'
                          : current
                            ? 'text-sm font-medium'
                            : 'text-sm text-muted-foreground'
                      }
                    >
                      {step.label}
                    </span>
                  </li>
                );
              })}
            </ol>

            {phase === 'syncing' ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium">
                    <DownloadCloud className="size-3.5" aria-hidden="true" />
                    Synchronising with the linked device
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {loadingPercent !== null ? `${loadingPercent}%` : 'in progress'}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={loadingPercent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${loadingPercent ?? 0}%` }} />
                </div>
                {loading?.message ? <p className="text-xs text-muted-foreground">WhatsApp reports: {loading.message}</p> : null}
              </div>
            ) : null}

            {currentAuthState ? (
              <p className="text-xs text-muted-foreground">
                WhatsApp state: <span className="font-mono font-medium text-foreground">{currentAuthState}</span>
              </p>
            ) : null}

            {sessionError ? (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertTitle>Session error</AlertTitle>
                <AlertDescription>{sessionError}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {selected?.connector === 'web' ? (
        <Alert variant="info">
          <AlertTriangle />
          <AlertTitle>Authorised WhatsApp Web connector</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>
              This connector is not an official WhatsApp API. It links a real phone through a browser session and should only be used
              with a record of the written authorisation you hold.
            </p>
            <p>For production business messaging, use the official WhatsApp Business Platform (Cloud API).</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>QR sign-in</CardTitle>
              <CardDescription>Link the device by scanning a short-lived code.</CardDescription>
            </div>
            <QrCode className="size-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-4">
            {capabilitiesQuery.loading && !capabilities ? (
              <TableSkeleton rows={2} columns={2} />
            ) : !capabilities ? (
              <Alert variant="warning">
                <AlertDescription>
                  Capability information could not be read for this connector, so sign-in controls are hidden.
                </AlertDescription>
              </Alert>
            ) : !capabilities.qrAuth ? (
              <Alert variant="muted">
                <AlertDescription>
                  The selected connector does not support QR sign-in. The Cloud API authenticates with server-side credentials instead.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {qr ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="relative rounded-lg border bg-white p-3">
                      <img src={qr.qrDataUrl} alt="WhatsApp linking QR code" className="size-48" width={192} height={192} />
                      {qrStale || qrRefreshing ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-background/85">
                          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
                          <p className="px-4 text-center text-xs font-medium text-muted-foreground">
                            Refreshing QR code — a new one is on its way…
                          </p>
                        </div>
                      ) : null}
                    </div>
                    {qrStale || qrRefreshing ? (
                      <p className="text-xs text-muted-foreground">WhatsApp rotates the code automatically; keep this page open.</p>
                    ) : (
                      <>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Timer className="size-3.5" aria-hidden="true" />
                          Refreshes in {qrSeconds ?? 0}s
                        </p>
                        <p className="text-center text-xs text-muted-foreground">
                          Scan with WhatsApp → Linked devices. The code is never stored by this dashboard.
                        </p>
                      </>
                    )}
                  </div>
                ) : qrStarting ? (
                  <div className="flex flex-col items-center gap-3 py-6">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
                    <p className="text-center text-sm text-muted-foreground">
                      {busy === 'qr'
                        ? 'Starting the browser and requesting a QR code…'
                        : 'Waiting for WhatsApp to issue a QR code… It will appear here automatically.'}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Start a QR sign-in to display a linking code. Codes rotate automatically and can be regenerated at any time.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={startQr} disabled={busy === 'qr'}>
                    {busy === 'qr' ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <QrCode className="size-4" aria-hidden="true" />
                    )}
                    {qr ? 'Refresh QR code' : qrStarting ? 'Starting…' : 'Start QR sign-in'}
                  </Button>
                  {qr ? (
                    <Button variant="ghost" onClick={() => { setQr(null); setQrRefreshing(false); }}>
                      Hide code
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Pairing code</CardTitle>
              <CardDescription>Link a phone by entering an 8-character code.</CardDescription>
            </div>
            <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-4">
            {capabilitiesQuery.loading && !capabilities ? (
              <TableSkeleton rows={2} columns={2} />
            ) : !capabilities ? (
              <Alert variant="warning">
                <AlertDescription>
                  Capability information could not be read for this connector, so pairing controls are hidden.
                </AlertDescription>
              </Alert>
            ) : !capabilities.pairingCode ? (
              <Alert variant="muted">
                <AlertDescription>
                  The selected connector does not support pairing codes. Use QR sign-in or the official Cloud API credentials.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <form className="space-y-3" onSubmit={requestPairingCode}>
                  <div className="space-y-2">
                    <Label htmlFor="pairing-phone">Phone number in international format</Label>
                    <Input
                      id="pairing-phone"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="15551234567"
                      value={phoneNumber}
                      onChange={(event) => setPhoneNumber(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Digits only, including the country code.</p>
                  </div>
                  <Button type="submit" disabled={busy === 'pairing' || phoneNumber.replace(/\D/g, '').length < 8}>
                    <KeyRound className="size-4" aria-hidden="true" />
                    Request pairing code
                  </Button>
                </form>

                {pairing ? (
                  <div className="rounded-lg border bg-muted/40 p-4 text-center">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Pairing code</p>
                    <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.3em]">{pairing.pairingCode}</p>
                    {pairingSeconds !== null ? (
                      <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                        <Timer className="size-3.5" aria-hidden="true" />
                        Expires in {pairingSeconds}s
                      </p>
                    ) : null}
                    <div className="mt-3 flex justify-center">
                      <CopyButton value={pairing.pairingCode} label="Copy code" variant="outline" />
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Enter this on the phone under Linked devices → Link with phone number. Never share it.
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Stored session</CardTitle>
              <CardDescription>What the gateway keeps on disk for this instance.</CardDescription>
            </div>
            <Link2 className="size-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-4">
            {sessionQuery.loading && !session ? (
              <TableSkeleton rows={2} columns={2} />
            ) : sessionQuery.error ? (
              <p className="text-sm text-muted-foreground">Session details are unavailable for this connector.</p>
            ) : (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Encrypted archive</dt>
                  <dd className="text-sm font-medium">
                    {session?.encryptedArchive?.present ? 'Stored' : 'None'}
                    {session?.encryptedArchive?.strategy ? ` · ${titleCase(session.encryptedArchive.strategy)}` : ''}
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Browser profile directory</dt>
                  <dd className="text-sm font-medium">{session?.browserProfileDirectory ? 'Present' : 'None'}</dd>
                </div>
                {session?.encryptedArchive?.updatedAt ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Last updated</dt>
                    <dd className="text-sm font-medium">{formatDateTime(session.encryptedArchive.updatedAt)}</dd>
                  </div>
                ) : null}
                {session?.encryptedArchive?.keyId ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Encryption key id</dt>
                    <dd className="font-mono text-sm font-medium">{session.encryptedArchive.keyId}</dd>
                  </div>
                ) : null}
                {session?.atRestEncryption ? (
                  <div className="space-y-0.5 sm:col-span-2">
                    <dt className="text-xs text-muted-foreground">At rest</dt>
                    <dd className="text-sm font-medium">{session.atRestEncryption}</dd>
                  </div>
                ) : null}
              </dl>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button variant="outline" size="sm" onClick={() => setRevokeOpen(true)} disabled={busy === 'revoke'}>
                <Trash2 className="size-4" aria-hidden="true" />
                Revoke stored session
              </Button>
              <p className="text-xs text-muted-foreground">
                Deletes the local authentication material. The instance and its retained messages are kept.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Disconnect</CardTitle>
              <CardDescription>Stop the session. Optionally remove the stored session.</CardDescription>
            </div>
            <PlugZap className="size-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="logout-on-disconnect" className="text-sm font-medium">
                  Also log out the device
                </Label>
                <p className="text-xs text-muted-foreground">
                  Removes the stored session material. The instance must be linked again afterwards.
                </p>
              </div>
              <Switch id="logout-on-disconnect" checked={logoutOnDisconnect} onCheckedChange={setLogoutOnDisconnect} />
            </div>
            <Button variant="destructive" onClick={() => setDisconnectOpen(true)} disabled={busy === 'disconnect'}>
              <Unplug className="size-4" aria-hidden="true" />
              Disconnect instance
            </Button>
            <p className="text-xs text-muted-foreground">
              Disconnecting does not delete the instance or its stored messages.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle>Live events</CardTitle>
            <CardDescription>Streamed authentication and connection events for this instance.</CardDescription>
          </div>
          <Badge variant={streamMeta.tone}>
            <LiveDot active={streamState === 'open'} />
            {streamMeta.label}
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <EmptyState
              icon={PlugZap}
              title="No events yet"
              description="Connection, QR and authentication events will appear here as they happen."
            />
          ) : (
            <ul className="divide-y">
              {events.map((event) => (
                <li key={event.key} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <Badge variant="muted" className="font-mono text-[11px]">
                      {event.type}
                    </Badge>
                    <span className="truncate text-sm">{EVENT_LABELS[event.type] ?? titleCase(event.type)}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(event.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <Separator />
          <p className="px-5 py-3 text-xs text-muted-foreground">
            QR payloads and pairing codes are shown only while they are valid and are never saved to your browser.
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect this instance?"
        description={
          logoutOnDisconnect
            ? 'The browser session is stopped and the stored session material is removed. The instance must be linked again afterwards.'
            : 'The session is stopped but the stored session material is kept, so it can reconnect without linking again.'
        }
        confirmLabel="Disconnect"
        destructive
        pending={busy === 'disconnect'}
        onConfirm={confirmDisconnect}
      />

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke the stored session?"
        description="The instance is disconnected with a logout and every local trace of its authentication material — the browser profile directory and the encrypted session archive — is deleted. The instance and its retained messages are not deleted, but the device must be linked again. This cannot be undone."
        confirmLabel="Revoke session"
        destructive
        pending={busy === 'revoke'}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}
