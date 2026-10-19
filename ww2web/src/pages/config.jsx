import { useEffect, useState } from 'react';
import {
  Activity,
  Cable,
  Clock,
  Database,
  Gauge,
  Info,
  Layers,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Switch } from '@/components/ui/switch.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { CardsSkeleton, TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { SecretStatus } from '@/components/common/one-time-secret.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { connectorsApi, instancesApi, uiApi } from '@/lib/api.js';
import { formatDuration, shortId, titleCase } from '@/lib/format.js';

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (typeof value === 'number') return new Intl.NumberFormat().format(value);
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, nested]) => `${titleCase(key)}: ${formatValue(nested)}`)
      .join(' · ');
  }
  return String(value);
}

function SettingSection({ title, description, icon: Icon, children, actions }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
            {title}
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SettingList({ items }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ConfigPage() {
  useDocumentTitle('Configuration');

  const configQuery = useApi(() => uiApi.config(), []);
  const connectorsQuery = useApi(() => connectorsApi.list(), []);
  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);

  const config = configQuery.data?.data ?? null;
  const connectors = connectorsQuery.data?.data?.connectors ?? null;
  const instances = instancesQuery.data?.data?.items ?? [];

  const [retentionId, setRetentionId] = useState(null);
  const [retentionEnabled, setRetentionEnabled] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [savingRetention, setSavingRetention] = useState(false);

  useEffect(() => {
    if (instances.length === 0) {
      setRetentionId(null);
      return;
    }
    if (!retentionId || !instances.some((item) => item.id === retentionId)) setRetentionId(instances[0].id);
  }, [instances, retentionId]);

  useEffect(() => {
    const selected = instances.find((item) => item.id === retentionId);
    if (selected) {
      setRetentionEnabled(Boolean(selected.retention?.enabled));
      setRetentionDays(selected.retention?.days ?? 30);
    }
  }, [retentionId, instances]);

  async function saveRetention() {
    if (!retentionId) return;
    setSavingRetention(true);
    try {
      await instancesApi.updateRetention(retentionId, {
        retentionEnabled,
        retentionDays: Number(retentionDays),
      });
      toast.success('Retention policy updated');
      instancesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not update the retention policy', { description: error.message });
    } finally {
      setSavingRetention(false);
    }
  }

  if (configQuery.loading && !config) {
    return (
      <div className="space-y-6">
        <PageHeader title="Configuration" description="Effective, read-only settings reported by the service." />
        <CardsSkeleton count={4} />
        <Card>
          <TableSkeleton rows={6} columns={2} />
        </Card>
      </div>
    );
  }

  if (configQuery.error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Configuration" description="Effective, read-only settings reported by the service." />
        <ErrorState error={configQuery.error} onRetry={configQuery.reload} title="Could not load configuration" />
      </div>
    );
  }

  if (!config) return null;

  const cloud = config.connectors?.cloud ?? {};
  const web = config.connectors?.web ?? {};
  const security = config.security ?? {};

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configuration"
        description="The settings this service is running with. Secrets are shown only as configured or not configured."
        actions={
          <Button variant="outline" size="sm" onClick={() => configQuery.reload()} disabled={configQuery.refetching}>
            <RefreshCw className={configQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Alert variant="muted">
        <Info />
        <AlertDescription>
          Values come from the server environment and are read-only here. Change them on the host and restart the service. This page
          never reveals secret values or filesystem paths.
        </AlertDescription>
      </Alert>

      {security.ephemeralSecrets ? (
        <Alert variant="warning">
          <ShieldAlert />
          <AlertTitle>Development secrets in use</AlertTitle>
          <AlertDescription>
            The API key pepper or the encryption key ring is ephemeral. Existing API keys and stored ciphertext will not survive a
            restart. Configure real secrets before running in production.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingSection title="Service" description="Identity and runtime of this process." icon={Activity}>
        <SettingList
          items={[
            ['Name', config.service?.name ?? '—'],
            ['Version', config.service?.version ? `v${config.service.version}` : '—'],
            ['Environment', titleCase(config.service?.environment ?? '—')],
            ['Production mode', config.service?.production ? 'Yes' : 'No'],
            ['Uptime', formatDuration((config.service?.uptimeSeconds ?? 0) * 1000)],
            ['Server time', config.service?.serverTime ?? '—'],
          ]}
        />
      </SettingSection>

      <SettingSection title="Connectors" description="Which connectors are available and what they support." icon={Cable}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">Default: {titleCase(config.connectors?.default ?? '—')}</Badge>
            {connectors ? (
              Object.entries(connectors).map(([key, capability]) => (
                <Badge key={key} variant={capability.enabled === false ? 'muted' : 'outline'}>
                  {titleCase(key)} {capability.enabled === false ? '· disabled' : '· available'}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">Capabilities unavailable</span>
            )}
          </div>

          <div className="rounded-md border">
            <div className="border-b px-3 py-2 text-sm font-medium">Official WhatsApp Cloud API</div>
            <div className="p-3">
              <SettingList
                items={[
                  ['Credentials', cloud.configured ? 'Configured' : 'Not configured'],
                  ['Access token', <SecretStatus key="token" configured={cloud.accessToken === 'configured'} />],
                  ['Phone number ID', <SecretStatus key="phone" configured={cloud.phoneNumberId === 'configured'} />],
                  ['Webhook verify token', <SecretStatus key="verify" configured={cloud.verifyToken === 'configured'} />],
                  ['App secret', <SecretStatus key="secret" configured={cloud.appSecret === 'configured'} />],
                  ['Webhooks', cloud.webhooksEnabled ? 'Enabled' : 'Disabled'],
                  ['Graph API version', cloud.apiVersion ?? '—'],
                  ['Graph base URL', cloud.graphBaseUrl ?? '—'],
                ]}
              />
            </div>
          </div>

          <div className="rounded-md border">
            <div className="border-b px-3 py-2 text-sm font-medium">Authorised WhatsApp Web connector</div>
            <div className="p-3">
              <SettingList
                items={[
                  ['Status', web.enabled ? 'Enabled' : 'Disabled'],
                  ['Authorisation reference', <SecretStatus key="ref" configured={web.authorizationReference === 'configured'} configuredLabel="Recorded" missingLabel="Not recorded" />],
                  ['Session strategy', titleCase(web.authStrategy ?? '—')],
                  ['Headless browser', web.headless ? 'Yes' : 'No'],
                  ['Maximum browser instances', web.maxInstances ?? '—'],
                  ['Launch timeout', web.launchTimeoutMs ? `${web.launchTimeoutMs} ms` : '—'],
                ]}
              />
            </div>
          </div>
        </div>
      </SettingSection>

      <SettingSection title="Security" description="Credential, encryption and transport posture." icon={ShieldCheck}>
        <SettingList
          items={[
            ['API key pepper', security.apiKeyPepper === 'configured' ? 'Configured' : security.apiKeyPepper ?? '—'],
            ['Encryption provider', titleCase(security.encryption?.provider ?? '—')],
            ['Active encryption key id', security.encryption?.activeKeyId ?? '—'],
            ['Encryption keys loaded', security.encryption?.keyCount ?? '—'],
            ['CORS origins configured', security.corsOriginsConfigured ?? 0],
            ['CORS wildcard', security.corsWildcard ? 'Yes — review before production' : 'No'],
            ['IP allowlist', security.ipAllowlistEnabled ? 'Enabled' : 'Disabled'],
            ['Trust proxy', security.trustProxy ? 'Enabled' : 'Disabled'],
            ['Request body limit', security.bodyLimit ?? '—'],
            ['Owner session lifetime', formatDuration(security.ownerSession?.ttlMs)],
            ['Owner session idle timeout', formatDuration(security.ownerSession?.idleMs)],
            ['Owner cookie secure', security.ownerSession?.secureCookie ? 'Yes' : 'No — expected on local http'],
            ['Maximum owner sessions', security.ownerSession?.maxSessions ?? '—'],
          ]}
        />
      </SettingSection>

      <SettingSection title="Reconnection" description="How the gateway re-establishes dropped sessions." icon={RefreshCw}>
        <SettingList
          items={[
            ['Reconnection', config.reconnection?.enabled ? 'Enabled' : 'Disabled'],
            ['Reconnect on startup', config.reconnection?.onStartup ? 'Yes' : 'No'],
            ['Base delay', formatDuration(config.reconnection?.baseDelayMs)],
            ['Maximum delay', formatDuration(config.reconnection?.maxDelayMs)],
            ['Maximum attempts', config.reconnection?.maxAttempts ?? '—'],
            ['Maximum duration', formatDuration(config.reconnection?.maxDurationMs)],
            ['Jitter', config.reconnection?.jitter ? 'Enabled' : 'Disabled'],
            ['Stable reset window', formatDuration(config.reconnection?.stableResetMs)],
          ]}
        />
      </SettingSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <SettingSection title="Rate limits" description="Per-key and per-IP request budgets." icon={Gauge}>
          <SettingList
            items={Object.entries(config.rateLimit ?? {}).flatMap(([scope, limits]) => [
              [`${titleCase(scope)} window`, formatDuration(limits?.windowMs)],
              [`${titleCase(scope)} maximum`, limits?.max ?? '—'],
            ])}
          />
        </SettingSection>

        <SettingSection title="Messaging" description="Outbound delivery behaviour." icon={SlidersHorizontal}>
          <SettingList
            items={[
              ['Outbound messaging', config.outbound?.enabled ? 'Enabled' : 'Disabled'],
              ['Idempotency window', formatDuration(config.outbound?.idempotencyTtlMs)],
              ['Delivery metadata retention', config.outbound?.deliveryRetentionDays ? `${config.outbound.deliveryRetentionDays} days` : 'Disabled'],
            ]}
          />
        </SettingSection>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SettingSection title="Real-time events" description="Server-sent event stream limits." icon={Layers}>
          <SettingList
            items={[
              ['Stream token lifetime', formatDuration(config.events?.streamTokenTtlMs)],
              ['Heartbeat interval', formatDuration(config.events?.heartbeatMs)],
              ['Maximum stream duration', formatDuration(config.events?.maxStreamMs)],
            ]}
          />
        </SettingSection>

        <SettingSection title="Limits and pagination" description="Instance limits and list page sizes." icon={Database}>
          <SettingList
            items={[
              ['Maximum browser instances', config.limits?.maxBrowserInstances ?? '—'],
              ['QR code lifetime', formatDuration(config.limits?.qrTtlMs)],
              ['Default page size', config.pagination?.defaultPageSize ?? '—'],
              ['Maximum page size', config.pagination?.maxPageSize ?? '—'],
            ]}
          />
        </SettingSection>
      </div>

      <SettingSection title="Storage and retention" description="Filesystem storage posture and default retention." icon={Database}>
        <SettingList
          items={[
            ['Storage mode', titleCase(config.storage?.mode ?? '—')],
            ['Data directory', config.storage?.dataDirConfigured ? 'Configured' : 'Not configured'],
            ['Data directory is default', config.storage?.dataDirIsDefault ? 'Yes' : 'No'],
            ['Default retention period', config.retention?.defaultDays ? `${config.retention.defaultDays} days` : '—'],
            ['Maximum retention period', config.retention?.maxDays ? `${config.retention.maxDays} days` : '—'],
            ['Retain message content by default', config.retention?.retainMessageContent ? 'Yes' : 'No'],
            ['Audit event retention', config.retention?.auditDays ? `${config.retention.auditDays} days` : '—'],
            ['Shutdown timeout', formatDuration(config.shutdown?.timeoutMs)],
          ]}
        />
      </SettingSection>

      <SettingSection title="Per-instance retention" description="The one setting the dashboard can change directly." icon={Database}>
        {instances.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create an instance to configure its retention policy.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="retention-instance">Instance</Label>
                <Select value={retentionId ?? undefined} onValueChange={setRetentionId}>
                  <SelectTrigger id="retention-instance">
                    <SelectValue placeholder="Select an instance" />
                  </SelectTrigger>
                  <SelectContent>
                    {instances.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.displayName || shortId(item.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="retention-days">Retention period (days)</Label>
                <Input
                  id="retention-days"
                  type="number"
                  min={0}
                  max={3650}
                  value={retentionDays}
                  onChange={(event) => setRetentionDays(event.target.value)}
                  disabled={!retentionEnabled}
                />
              </div>
            </div>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="retention-enabled" className="text-sm font-medium">
                  Retain inbound message content
                </Label>
                <p className="text-xs text-muted-foreground">
                  When disabled, message bodies are not stored and read endpoints return no history.
                </p>
              </div>
              <Switch id="retention-enabled" checked={retentionEnabled} onCheckedChange={setRetentionEnabled} />
            </div>
            <Button onClick={saveRetention} disabled={savingRetention || !retentionId}>
              <Save className="size-4" aria-hidden="true" />
              {savingRetention ? 'Saving…' : 'Save retention policy'}
            </Button>
          </div>
        )}
      </SettingSection>

      <Card>
        <CardHeader className="flex-row items-start gap-2 space-y-0">
          <Clock className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <CardTitle>Applying changes</CardTitle>
            <CardDescription>
              Edit the environment on the host (for example <span className="font-mono">.env</span>) and restart the service. Configuration is
              validated at startup and the process refuses to start with insecure production settings.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
