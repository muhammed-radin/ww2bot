import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Cpu,
  Gauge,
  MessageSquare,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Separator } from '@/components/ui/separator.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { CardsSkeleton, TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { LiveDot, StatusBadge } from '@/components/common/status-badge.jsx';
import { StatCard } from '@/components/common/stat-card.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { useStatus } from '@/hooks/use-status.jsx';
import { healthApi } from '@/lib/api.js';
import { formatRelative, shortId, titleCase } from '@/lib/format.js';

function QuickAction({ to, icon: Icon, label, description }) {
  return (
    <Button asChild variant="outline" className="h-auto justify-start gap-3 px-3 py-2.5">
      <Link to={to}>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="text-sm font-medium">{label}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{description}</span>
        </span>
        <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </Button>
  );
}

export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const { overview, loading, error, reload } = useStatus();
  const health = useApi(() => healthApi.ready(), [], { pollMs: 30000 });

  const primary = overview?.primary ?? null;
  const byStatus = overview?.connections?.byStatus ?? {};
  const total = overview?.connections?.total ?? 0;
  const readyCount = byStatus.ready ?? 0;
  const browsers = overview?.browsers ?? null;

  const readiness = health.data?.data ?? null;
  const isReady = !health.error && readiness?.status === 'ready';
  const readinessChecked = Boolean(readiness) || Boolean(health.error);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="A live summary of the WhatsApp service, its connections and recent activity."
        actions={
          <Button variant="outline" size="sm" onClick={() => { reload(); health.reload(); }} disabled={loading || health.refetching}>
            <RefreshCw className={loading || health.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {error ? <ErrorState error={error} onRetry={reload} title="Could not load the service summary" /> : null}

      {loading && !overview ? (
        <CardsSkeleton count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Service"
            value={overview?.service?.version ? `v${overview.service.version}` : '—'}
            hint={overview?.service?.environment ? `${titleCase(overview.service.environment)} environment` : 'Environment unknown'}
            icon={Activity}
            tone="info"
          />
          <StatCard
            label="Connections"
            value={total}
            hint={total === 0 ? 'No instances configured' : `${readyCount} ready to send`}
            icon={Plug}
            tone={readyCount > 0 ? 'success' : total > 0 ? 'warning' : 'muted'}
          />
          <StatCard
            label="Ready / degraded"
            value={readinessChecked ? (isReady ? 'Ready' : 'Degraded') : '—'}
            hint={readiness?.checks?.storage?.mode ? `Storage ${readiness.checks.storage.mode}` : 'Dependency check unavailable'}
            icon={Gauge}
            tone={readinessChecked ? (isReady ? 'success' : 'warning') : 'muted'}
          />
          <StatCard
            label="Browser instances"
            value={browsers ? `${browsers.running} / ${browsers.max}` : '—'}
            hint={overview?.features?.webConnectorEnabled ? 'WhatsApp Web connector enabled' : 'Web connector disabled'}
            icon={Cpu}
            tone={browsers?.running > 0 ? 'info' : 'muted'}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Primary connection</CardTitle>
              <CardDescription>The connector currently doing the work.</CardDescription>
            </div>
            {primary ? <StatusBadge kind="connection" status={primary.connectionState} /> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {loading && !overview ? (
              <TableSkeleton rows={3} columns={2} />
            ) : !primary ? (
              <EmptyState
                icon={Server}
                title="No instances yet"
                description="Create an instance to connect a WhatsApp number."
                action={
                  <Button asChild size="sm">
                    <Link to="/instances">Create an instance</Link>
                  </Button>
                }
              />
            ) : (
              <>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Instance</dt>
                    <dd className="truncate text-sm font-medium">{primary.displayName || shortId(primary.instanceId)}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Connector</dt>
                    <dd className="text-sm font-medium">{titleCase(primary.connector)}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Live session</dt>
                    <dd className="flex items-center gap-2 text-sm font-medium">
                      <LiveDot active={primary.live} />
                      {primary.live ? 'Running' : 'Not running'}
                    </dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Reconnect attempts</dt>
                    <dd className="text-sm font-medium tabular-nums">{primary.attempt ?? 0}</dd>
                  </div>
                  {primary.details?.linkedUser ? (
                    <div className="space-y-0.5">
                      <dt className="text-xs text-muted-foreground">Linked account</dt>
                      <dd className="truncate text-sm font-medium">{primary.details.pushname ? `${primary.details.pushname} · ` : ''}{primary.details.linkedUser}</dd>
                    </div>
                  ) : null}
                </dl>

                {primary.lastError ? (
                  <Alert variant="warning">
                    <AlertTitle>Last error</AlertTitle>
                    <AlertDescription>{primary.lastError}</AlertDescription>
                  </Alert>
                ) : null}

                <Button asChild variant="outline" size="sm">
                  <Link to="/connection">Open connection controls</Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
            <CardDescription>Common administration tasks.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <QuickAction to="/connection" icon={Plug} label="Connection" description="Scan a QR code or use a pairing code" />
            <QuickAction to="/instances" icon={Server} label="Instances" description="Create, inspect or remove instances" />
            <QuickAction to="/messaging" icon={MessageSquare} label="Messaging" description="Delivery activity and test sends" />
            <QuickAction to="/security" icon={ShieldCheck} label="Security" description="Manage API keys and owner access" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Recent events</CardTitle>
              <CardDescription>Latest entries from the audit trail.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/logs">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {loading && !overview ? (
              <TableSkeleton rows={5} columns={3} />
            ) : (overview?.recentEvents?.length ?? 0) === 0 ? (
              <EmptyState icon={Activity} title="No events yet" description="Connection and authentication events will appear here." />
            ) : (
              <ul className="divide-y">
                {overview.recentEvents.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{titleCase(event.action)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {event.instanceId ? shortId(event.instanceId) : 'service'} · {formatRelative(event.createdAt)}
                      </p>
                    </div>
                    <StatusBadge kind="result" status={event.result} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Recent deliveries</CardTitle>
              <CardDescription>Outbound requests recorded by the gateway.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/messaging">Open messaging</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {loading && !overview ? (
              <TableSkeleton rows={5} columns={3} />
            ) : (overview?.recentDeliveries?.length ?? 0) === 0 ? (
              <EmptyState icon={MessageSquare} title="No deliveries yet" description="Outbound messages sent through the API will be listed here." />
            ) : (
              <ul className="divide-y">
                {overview.recentDeliveries.map((delivery) => (
                  <li key={delivery.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{delivery.recipientMasked ?? 'Recipient hidden'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {shortId(delivery.instanceId)} · {formatRelative(delivery.createdAt)}
                      </p>
                    </div>
                    <StatusBadge kind="delivery" status={delivery.status} />
                  </li>
                ))}
              </ul>
            )}
            <Separator />
            <p className="px-5 py-3 text-xs text-muted-foreground">
              Message bodies are never listed. Submitted content is shown only where the operator enabled retention.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
