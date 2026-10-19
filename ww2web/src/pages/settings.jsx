import { useNavigate } from 'react-router-dom';
import {
  Activity,
  CheckCircle2,
  Info,
  LogOut,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  Timer,
  UserRound,
  XCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { CopyButton } from '@/components/common/copy-button.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useAuth } from '@/hooks/use-auth.jsx';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { usePreference } from '@/hooks/use-preference.js';
import { REFRESH_INTERVAL_KEY, REFRESH_INTERVAL_OPTIONS, useStatus } from '@/hooks/use-status.jsx';
import { useTheme } from '@/hooks/use-theme.jsx';
import { healthApi, uiApi } from '@/lib/api.js';
import { formatDateTime, formatRelative, shortId, titleCase } from '@/lib/format.js';
import { cn } from '@/lib/utils.js';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const UI_VERSION = typeof __UI_VERSION__ === 'string' ? __UI_VERSION__ : '0.0.0';
const UI_BUILD_TIME = typeof __UI_BUILD_TIME__ === 'string' ? __UI_BUILD_TIME__ : null;

function SettingRow({ label, value, hint }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words text-sm font-medium">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default function SettingsPage() {
  useDocumentTitle('Settings');

  const { theme, setTheme, resolvedTheme } = useTheme();
  const [refreshInterval, setRefreshInterval] = usePreference(REFRESH_INTERVAL_KEY, 15000);
  const { owner, expiresAt, logout } = useAuth();
  const { overview } = useStatus();
  const navigate = useNavigate();

  const configQuery = useApi(() => uiApi.config(), []);
  const healthQuery = useApi(() => healthApi.ready(), [], { pollMs: 30000 });

  const config = configQuery.data?.data ?? null;
  const checks = healthQuery.data?.data?.checks ?? null;
  const readiness = healthQuery.data?.data?.status ?? null;

  async function handleSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  const browsers = overview?.browsers ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your dashboard preferences, the current session and service diagnostics." />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="size-4 text-muted-foreground" aria-hidden="true" />
            Appearance
          </CardTitle>
          <CardDescription>Theme and how often live status is refreshed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Theme</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
              {THEME_OPTIONS.map((option) => {
                const selected = theme === option.value;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={selected}
                    onClick={() => setTheme(option.value)}
                  >
                    <option.icon className="size-4" aria-hidden="true" />
                    {option.label}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Currently showing the {resolvedTheme} theme. Stored locally in this browser only.
            </p>
          </div>

          <div className="space-y-2 sm:max-w-xs">
            <Label htmlFor="refresh-interval">Live status refresh</Label>
            <Select value={String(refreshInterval)} onValueChange={(value) => setRefreshInterval(Number(value))}>
              <SelectTrigger id="refresh-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REFRESH_INTERVAL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Shorten this only if you need faster feedback on the dashboard.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
              Owner session
            </CardTitle>
            <CardDescription>The credential behind this dashboard, and when it expires.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingRow label="Owner" value={owner?.name ?? 'Owner'} />
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground">Key id</p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{owner?.keyId ? shortId(owner.keyId) : '—'}</span>
                {owner?.keyId ? <CopyButton value={owner.keyId} label="Copy" /> : null}
              </div>
            </div>
            <SettingRow
              label="Session expiry"
              value={expiresAt ? formatDateTime(expiresAt) : '—'}
              hint={expiresAt ? formatRelative(expiresAt) : undefined}
            />
            <SettingRow
              label="Scope granted"
              value={owner?.scopes?.length ? `${owner.scopes.length} scopes` : '—'}
              hint={owner?.isWildcard ? 'Wildcard access' : undefined}
            />
          </div>

          {owner?.scopes?.length ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Scopes</p>
              <div className="flex flex-wrap gap-1.5">
                {owner.scopes.map((scope) => (
                  <Badge key={scope} variant="muted" className="font-mono text-[11px]">
                    {scope}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          <Alert variant="muted">
            <ShieldCheck />
            <AlertDescription>
              The session lives in an HttpOnly, SameSite=Strict cookie that page scripts cannot read. State-changing requests carry a CSRF
              token held in memory only, so a reload re-validates the session and nothing sensitive is written to browser storage.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="size-4 text-muted-foreground" aria-hidden="true" />
              About
            </CardTitle>
            <CardDescription>Dashboard and service versions.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <SettingRow label="Dashboard version" value={`v${UI_VERSION}`} />
            <SettingRow label="Dashboard built" value={UI_BUILD_TIME ? formatDateTime(UI_BUILD_TIME) : '—'} />
            <SettingRow label="Service version" value={config?.service?.version ? `v${config.service.version}` : '—'} />
            <SettingRow label="Environment" value={titleCase(config?.service?.environment ?? '—')} />
            <SettingRow label="Storage mode" value={titleCase(config?.storage?.mode ?? '—')} />
            <SettingRow label="Uptime" value={config?.service?.uptimeSeconds !== undefined ? formatRelative(Date.now() - config.service.uptimeSeconds * 1000) : '—'} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
                Diagnostics
              </CardTitle>
              <CardDescription>Dependency readiness reported by the service.</CardDescription>
            </div>
            {readiness === 'ready' ? (
              <Badge variant="success">Ready</Badge>
            ) : healthQuery.error ? (
              <Badge variant="warning">Degraded</Badge>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {healthQuery.loading && !checks ? (
              <TableSkeleton rows={3} columns={2} />
            ) : healthQuery.error && !checks ? (
              <p className="text-sm text-muted-foreground">
                Readiness details are unavailable. The service responded that it is not ready.
              </p>
            ) : (
              <ul className="space-y-2">
                {checks?.storage ? (
                  <li className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      {checks.storage.ok ? (
                        <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
                      ) : (
                        <XCircle className="size-4 text-destructive" aria-hidden="true" />
                      )}
                      Storage ({checks.storage.mode})
                    </span>
                    <span className="text-muted-foreground">{checks.storage.ok ? 'Writable' : 'Unavailable'}</span>
                  </li>
                ) : null}
                {checks?.realtime ? (
                  <li className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      {checks.realtime.ok ? (
                        <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
                      ) : (
                        <XCircle className="size-4 text-destructive" aria-hidden="true" />
                      )}
                      Real-time events ({checks.realtime.mode})
                    </span>
                    <span className="text-muted-foreground">{checks.realtime.ok ? 'Operational' : 'Unavailable'}</span>
                  </li>
                ) : null}
                {browsers ? (
                  <li className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      <Timer className="size-4 text-muted-foreground" aria-hidden="true" />
                      Browser instances
                    </span>
                    <span className={cn('text-muted-foreground', browsers.running > 0 && 'text-foreground')}>
                      {browsers.running} running / {browsers.max} allowed
                    </span>
                  </li>
                ) : null}
              </ul>
            )}
            {configQuery.error ? <ErrorState error={configQuery.error} onRetry={configQuery.reload} title="Could not load service details" /> : null}
          </CardContent>
        </Card>
      </div>

      <Alert variant="info">
        <Info />
        <AlertTitle>Where to change service settings</AlertTitle>
        <AlertDescription>
          Everything on the Configuration page is read-only here. Edit the server environment on the host and restart the service; startup
          validation rejects insecure production configuration.
        </AlertDescription>
      </Alert>
    </div>
  );
}
