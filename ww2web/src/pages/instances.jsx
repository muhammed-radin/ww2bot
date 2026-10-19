import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Database, Eraser, History, Info, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent } from '@/components/ui/card.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Skeleton } from '@/components/ui/skeleton.jsx';
import { Switch } from '@/components/ui/switch.jsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.jsx';
import { ConfirmDialog } from '@/components/common/confirm-dialog.jsx';
import { CopyButton } from '@/components/common/copy-button.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { StatusBadge } from '@/components/common/status-badge.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { connectorsApi, instancesApi } from '@/lib/api.js';
import { auditResult, formatDateTime, formatRelative, shortId, titleCase } from '@/lib/format.js';

const CONNECTOR_LABELS = {
  cloud_api: 'Cloud API (official)',
  web: 'WhatsApp Web (authorised)',
};

const EMPTY_FORM = {
  connector: 'cloud_api',
  displayName: '',
  retentionEnabled: false,
  retentionDays: 30,
  label: '',
  phoneNumberId: '',
};

export default function InstancesPage() {
  useDocumentTitle('Instances');

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);
  const connectorsQuery = useApi(() => connectorsApi.list(), []);

  const instances = instancesQuery.data?.data?.items ?? [];
  const connectors = connectorsQuery.data?.data?.connectors ?? null;
  const webEnabled = Boolean(connectors?.web?.enabled);
  const cloudConfigured = Boolean(connectors?.cloud_api?.configured);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [purging, setPurging] = useState(false);

  const listDetail = useMemo(() => instances.find((item) => item.id === detailId) ?? null, [instances, detailId]);

  // `GET /instances/:id` is the authoritative view: the table row may be older
  // than the latest status change, and it also carries the connector's
  // capabilities. Responses are keyed by id so a previous instance's payload
  // can never be shown for the current one.
  const detailQuery = useApi(() => instancesApi.get(detailId), [detailId], { immediate: Boolean(detailId) });
  const freshDetail = detailQuery.data?.data?.instance?.id === detailId ? detailQuery.data.data.instance : null;
  const detail = freshDetail ?? listDetail;
  const detailCapabilities =
    freshDetail && detailQuery.data?.data?.capabilities
      ? detailQuery.data.data.capabilities
      : (connectors?.[detail?.connector] ?? null);

  const auditQuery = useApi(
    async () => {
      const result = await instancesApi.auditEvents(detailId, { limit: 25 });
      // The endpoint's response does not echo the instance id, so tag it here
      // and ignore anything belonging to a previously opened instance.
      return { ...result, instanceId: detailId };
    },
    [detailId],
    { immediate: Boolean(detailId) },
  );
  const auditEvents = auditQuery.data?.instanceId === detailId ? auditQuery.data.data.items : [];

  function openCreate() {
    // Prefer a connector that can actually authenticate on this host: if Meta
    // credentials are absent but the Web connector is enabled, default to Web.
    const preferred = webEnabled && !cloudConfigured ? 'web' : 'cloud_api';
    setForm({ ...EMPTY_FORM, connector: preferred });
    setCreateOpen(true);
  }

  async function submitCreate(event) {
    event.preventDefault();
    setCreating(true);
    try {
      const payload = { connector: form.connector, displayName: form.displayName.trim() || undefined };
      payload.retentionEnabled = form.retentionEnabled;
      payload.retentionDays = Number(form.retentionDays);
      const metadata = {};
      if (form.label.trim()) metadata.label = form.label.trim();
      if (form.connector === 'cloud_api' && form.phoneNumberId.trim()) metadata.phoneNumberId = form.phoneNumberId.trim();
      if (Object.keys(metadata).length > 0) payload.metadata = metadata;

      await instancesApi.create(payload);
      toast.success('Instance created', { description: 'Open the Connection page to link it.' });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      instancesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not create the instance', { description: error.message });
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await instancesApi.remove(deleteTarget.id);
      toast.success('Instance deleted', { description: 'Its stored data was removed with it.' });
      setDeleteTarget(null);
      if (detailId === deleteTarget.id) setDetailId(null);
      instancesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not delete the instance', { description: error.message });
    } finally {
      setDeleting(false);
    }
  }

  async function confirmPurge() {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      const { data } = await instancesApi.purge(purgeTarget.id);
      toast.success('Retained data purged', {
        description: `${data.messagesDeleted ?? 0} message(s), ${data.webhookEventsDeleted ?? 0} webhook event(s) and ${
          data.deliveriesDeleted ?? 0
        } delivery record(s) removed. The instance and its session were kept.`,
      });
      setPurgeTarget(null);
      instancesQuery.reload({ silent: true });
      detailQuery.reload({ silent: true });
      auditQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not purge retained data', { description: error.message });
    } finally {
      setPurging(false);
    }
  }

  const retentionLabel = (instance) =>
    instance.retention?.enabled ? `${instance.retention.days} day${instance.retention.days === 1 ? '' : 's'}` : 'Disabled';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Instances"
        description="Each instance is one WhatsApp connector session with its own storage and retention policy."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => instancesQuery.reload()} disabled={instancesQuery.refetching}>
              <RefreshCw className={instancesQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
              Refresh
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              New instance
            </Button>
          </>
        }
      />

      {connectorsQuery.data && !webEnabled ? (
        <Alert variant="muted">
          <Info />
          <AlertDescription>
            The authorised WhatsApp Web connector is disabled on this host. Only the official Cloud API connector can be selected.
          </AlertDescription>
        </Alert>
      ) : null}

      {connectorsQuery.data && webEnabled && !cloudConfigured ? (
        <Alert variant="info">
          <Info />
          <AlertDescription>
            Cloud API credentials are not configured on this host (<code>META_ACCESS_TOKEN</code> /{' '}
            <code>META_PHONE_NUMBER_ID</code>), so new instances default to the Web connector. Configure those variables to
            verify Cloud API instances.
          </AlertDescription>
        </Alert>
      ) : null}

      {instancesQuery.error ? (
        <ErrorState error={instancesQuery.error} onRetry={instancesQuery.reload} title="Could not load instances" />
      ) : (
        <Card>
          <CardContent className="p-0">
            {instancesQuery.loading && instances.length === 0 ? (
              <TableSkeleton rows={4} columns={5} />
            ) : instances.length === 0 ? (
              <EmptyState
                icon={Server}
                title="No instances yet"
                description="Create an instance to connect a WhatsApp number to this gateway."
                action={
                  <Button size="sm" onClick={openCreate}>
                    <Plus className="size-4" aria-hidden="true" />
                    New instance
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Instance</TableHead>
                    <TableHead>Connector</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {instances.map((instance) => (
                    <TableRow key={instance.id}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{instance.displayName || 'Unnamed instance'}</span>
                          <span className="font-mono text-xs text-muted-foreground">{shortId(instance.id)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{CONNECTOR_LABELS[instance.connector] ?? titleCase(instance.connector)}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge kind="instance" status={instance.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{retentionLabel(instance)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setDetailId(instance.id)}>
                            Details
                          </Button>
                          <Button asChild variant="ghost" size="sm">
                            <Link to="/connection">Connect</Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${instance.displayName || instance.id}`}
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(instance)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create instance */}
      <Dialog open={createOpen} onOpenChange={(open) => (!creating ? setCreateOpen(open) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New instance</DialogTitle>
            <DialogDescription>Choose a connector and give the instance a recognisable label.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitCreate}>
            <div className="space-y-2">
              <Label htmlFor="create-connector">Connector</Label>
              <Select value={form.connector} onValueChange={(value) => setForm((current) => ({ ...current, connector: value }))}>
                <SelectTrigger id="create-connector">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cloud_api">{CONNECTOR_LABELS.cloud_api}</SelectItem>
                  <SelectItem value="web" disabled={!webEnabled}>
                    {CONNECTOR_LABELS.web}
                    {webEnabled ? '' : ' — disabled'}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.connector === 'cloud_api'
                  ? 'Verifies your Meta credentials and uses signed webhooks. Recommended for production.'
                  : 'Links a real device through a browser session. Requires written authorisation.'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-name">Display name</Label>
              <Input
                id="create-name"
                maxLength={80}
                placeholder="Support line"
                value={form.displayName}
                onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-label">Internal label (optional)</Label>
              <Input
                id="create-label"
                maxLength={64}
                placeholder="team-support"
                value={form.label}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
              />
            </div>

            {form.connector === 'cloud_api' ? (
              <div className="space-y-2">
                <Label htmlFor="create-phone-number-id">Meta phone number ID (optional)</Label>
                <Input
                  id="create-phone-number-id"
                  inputMode="numeric"
                  placeholder="123456789012345"
                  value={form.phoneNumberId}
                  onChange={(event) => setForm((current) => ({ ...current, phoneNumberId: event.target.value }))}
                />
                <p className="text-xs text-muted-foreground">Stored as instance metadata only; secrets stay in the server environment.</p>
              </div>
            ) : null}

            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="create-retention" className="text-sm font-medium">
                    Retain inbound message content
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Disabled by default. Only enable it if you need to read message history through the API.
                  </p>
                </div>
                <Switch
                  id="create-retention"
                  checked={form.retentionEnabled}
                  onCheckedChange={(checked) => setForm((current) => ({ ...current, retentionEnabled: checked }))}
                />
              </div>
              {form.retentionEnabled ? (
                <div className="space-y-2">
                  <Label htmlFor="create-retention-days">Retention period (days)</Label>
                  <Input
                    id="create-retention-days"
                    type="number"
                    min={0}
                    max={3650}
                    value={form.retentionDays}
                    onChange={(event) => setForm((current) => ({ ...current, retentionDays: event.target.value }))}
                  />
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create instance'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Instance details */}
      <Dialog open={Boolean(detailId)} onOpenChange={(open) => (!open ? setDetailId(null) : null)}>
        <DialogContent className="max-w-2xl">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle>{detail.displayName || 'Unnamed instance'}</DialogTitle>
                <DialogDescription>Read-only details, connector capabilities and recent audit events.</DialogDescription>
              </DialogHeader>

              {detailQuery.error ? (
                <ErrorState
                  error={detailQuery.error}
                  onRetry={() => detailQuery.reload()}
                  title="Could not refresh this instance"
                />
              ) : null}

              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                <div className="space-y-0.5 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Instance id</dt>
                  <dd className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{detail.id}</span>
                    <CopyButton value={detail.id} label="Copy" />
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Connector</dt>
                  <dd className="text-sm font-medium">{CONNECTOR_LABELS[detail.connector] ?? titleCase(detail.connector)}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd className="flex items-center gap-2">
                    <StatusBadge kind="instance" status={detail.status} />
                    {!freshDetail ? <span className="text-xs text-muted-foreground">refreshing…</span> : null}
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Retention</dt>
                  <dd className="text-sm font-medium">{retentionLabel(detail)}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Created</dt>
                  <dd className="text-sm font-medium">{formatDateTime(detail.createdAt)}</dd>
                </div>
                {detail.lastConnectedAt ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Last connected</dt>
                    <dd className="text-sm font-medium">{formatDateTime(detail.lastConnectedAt)}</dd>
                  </div>
                ) : null}
                {detail.metadata?.label ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Internal label</dt>
                    <dd className="text-sm font-medium">{detail.metadata.label}</dd>
                  </div>
                ) : null}
                {detail.metadata?.phoneNumberId ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Meta phone number ID</dt>
                    <dd className="font-mono text-sm font-medium">{detail.metadata.phoneNumberId}</dd>
                  </div>
                ) : null}
              </dl>

              {detailCapabilities ? (
                <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Database className="size-4 text-muted-foreground" aria-hidden="true" />
                    Connector capabilities
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries({
                      'QR sign-in': detailCapabilities.qrAuth,
                      'Pairing code': detailCapabilities.pairingCode,
                      'Outbound messaging': detailCapabilities.outboundMessaging,
                      'Read chats': detailCapabilities.listChats,
                      'Read messages': detailCapabilities.listMessages,
                      'Read contacts': detailCapabilities.listContacts,
                      Webhooks: detailCapabilities.webhooks,
                    }).map(([label, supported]) => (
                      <Badge key={label} variant={supported ? 'success' : 'muted'}>
                        {label}
                      </Badge>
                    ))}
                  </div>
                  {detailCapabilities.limitations?.length ? (
                    <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {detailCapabilities.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <History className="size-4 text-muted-foreground" aria-hidden="true" />
                    Recent audit events
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => auditQuery.reload()} disabled={auditQuery.refetching}>
                    <RefreshCw className={auditQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
                    Refresh
                  </Button>
                </div>

                {auditQuery.error ? (
                  <ErrorState error={auditQuery.error} onRetry={() => auditQuery.reload()} title="Could not load audit events" />
                ) : auditQuery.loading && auditEvents.length === 0 ? (
                  <TableSkeleton rows={3} columns={2} />
                ) : auditEvents.length === 0 ? (
                  <p className="rounded-md border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
                    No audit events have been recorded for this instance yet.
                  </p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {auditEvents.map((event) => {
                      const result = auditResult(event.result);
                      return (
                        <li key={event.id} className="flex items-start justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-xs font-medium">{event.action}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {event.actorKeyId ? `API key ${shortId(event.actorKeyId, { head: 8, tail: 4 })}` : 'Owner session'}
                              {event.requestId ? ` · request ${shortId(event.requestId, { head: 8, tail: 4 })}` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge variant={result.tone}>{result.label}</Badge>
                            <span className="text-xs text-muted-foreground" title={formatDateTime(event.createdAt)}>
                              {formatRelative(event.createdAt)}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Showing the 25 most recent events for this instance. The{' '}
                  <Link to="/logs" className="font-medium text-primary underline underline-offset-2">
                    Logs page
                  </Link>{' '}
                  covers every instance.
                </p>
              </section>

              <section className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <Eraser className="size-4" aria-hidden="true" />
                  Purge retained data
                </p>
                <p className="text-xs text-muted-foreground">
                  Deletes retained inbound messages, webhook events and delivery records for this instance. The instance, its WhatsApp
                  session and its configuration are kept.
                </p>
                <Button variant="destructive" size="sm" onClick={() => setPurgeTarget(detail)}>
                  <Eraser className="size-4" aria-hidden="true" />
                  Purge data
                </Button>
              </section>

              <DialogFooter>
                <Button asChild variant="outline">
                  <Link to="/connection">Open connection</Link>
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(detail);
                    setDetailId(null);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete instance
                </Button>
              </DialogFooter>
            </>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : null)}
        title="Delete this instance?"
        description={
          deleteTarget
            ? `"${deleteTarget.displayName || shortId(deleteTarget.id)}" and its stored data (messages, deliveries and session material) will be permanently removed. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete instance"
        destructive
        pending={deleting}
        onConfirm={confirmDelete}
      >
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>Deleting is irreversible. Disconnect first if you only want to stop the session.</AlertDescription>
        </Alert>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(purgeTarget)}
        onOpenChange={(open) => (!open ? setPurgeTarget(null) : null)}
        title="Purge retained data?"
        description={
          purgeTarget
            ? `Messages, webhook events and delivery records stored for "${
                purgeTarget.displayName || shortId(purgeTarget.id)
              }" will be deleted permanently. The instance and its WhatsApp session are kept.`
            : ''
        }
        confirmLabel="Purge data"
        destructive
        pending={purging}
        onConfirm={confirmPurge}
      >
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>
            Retained message bodies and delivery history cannot be recovered. If you only want to stop the connection, use the
            Connection page instead.
          </AlertDescription>
        </Alert>
      </ConfirmDialog>
    </div>
  );
}
