import { useMemo, useState } from 'react';
import { AlertTriangle, Info, KeyRound, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.jsx';
import { ConfirmDialog } from '@/components/common/confirm-dialog.jsx';
import { CopyButton } from '@/components/common/copy-button.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { OneTimeSecret } from '@/components/common/one-time-secret.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { keysApi } from '@/lib/api.js';
import { formatDateTime, formatRelative, shortId } from '@/lib/format.js';
import { cn } from '@/lib/utils.js';

const SERVICE_PRESET = ['messages:send', 'instances:read', 'connection:read'];
const NO_EXPIRY = 'none';

function keyStatus(key) {
  if (key.revokedAt) return { label: 'Revoked', tone: 'muted' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return { label: 'Expired', tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

export default function SecurityPage() {
  useDocumentTitle('Security');

  const keysQuery = useApi(() => keysApi.list({ limit: 200 }), []);
  const keys = keysQuery.data?.data?.items ?? [];
  const availableScopes = keysQuery.data?.data?.availableScopes ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', scopes: [], ttl: '365' });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState(null);
  const [rotateTarget, setRotateTarget] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [detailKeyId, setDetailKeyId] = useState(null);

  const ownerScopes = useMemo(() => ['auth:manage', 'keys:manage'], []);

  // Fresh detail for one key. `GET /api-keys/:keyId` is the authoritative view;
  // the list row is shown immediately while it loads.
  const detailQuery = useApi(() => keysApi.get(detailKeyId), [detailKeyId], { immediate: Boolean(detailKeyId) });
  const fetchedDetail = detailQuery.data?.data?.keyId === detailKeyId ? detailQuery.data.data : null;
  const listDetail = useMemo(() => keys.find((key) => key.keyId === detailKeyId) ?? null, [keys, detailKeyId]);
  const detailKey = fetchedDetail ?? listDetail;

  function toggleScope(scope) {
    setForm((current) => ({
      ...current,
      scopes: current.scopes.includes(scope) ? current.scopes.filter((item) => item !== scope) : [...current.scopes, scope],
    }));
  }

  function openCreate() {
    setForm({ name: '', scopes: ['messages:send'], ttl: '365' });
    setCreateOpen(true);
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (form.scopes.length === 0) {
      toast.error('Select at least one scope');
      return;
    }
    setCreating(true);
    try {
      const payload = { name: form.name.trim() || undefined, scopes: form.scopes };
      if (form.ttl !== NO_EXPIRY) payload.ttlDays = Number(form.ttl);
      const { data } = await keysApi.create(payload);
      setCreateOpen(false);
      setSecret({ apiKey: data.apiKey, warning: data.warning });
      keysQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not create the key', { description: error.message });
    } finally {
      setCreating(false);
    }
  }

  async function confirmRotate() {
    if (!rotateTarget) return;
    setRotating(true);
    try {
      const { data } = await keysApi.rotate(rotateTarget.keyId);
      setRotateTarget(null);
      setSecret({ apiKey: data.apiKey, warning: data.warning });
      keysQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not rotate the key', { description: error.message });
    } finally {
      setRotating(false);
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await keysApi.revoke(revokeTarget.keyId);
      toast.success('Key revoked', { description: 'Requests using it will now be rejected.' });
      setRevokeTarget(null);
      keysQuery.reload({ silent: true });
    } catch (error) {
      toast.error('Could not revoke the key', { description: error.message });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="Owner access and API credentials. Plaintext keys are shown once and can never be retrieved again."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => keysQuery.reload()} disabled={keysQuery.refetching}>
              <RefreshCw className={keysQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
              Refresh
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Create key
            </Button>
          </>
        }
      />

      <Alert variant="info">
        <ShieldCheck />
        <AlertTitle>Two kinds of key</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            <span className="font-medium text-foreground">Owner keys</span> hold <span className="font-mono">auth:manage</span> and{' '}
            <span className="font-mono">keys:manage</span> and are the only keys that can sign in to this dashboard.
          </p>
          <p>
            The <span className="font-medium text-foreground">RazorBills service key</span> should hold{' '}
            <span className="font-mono">messages:send</span> only, so the messaging integration can never administer the service.
          </p>
        </AlertDescription>
      </Alert>

      {keysQuery.error ? (
        <ErrorState error={keysQuery.error} onRetry={keysQuery.reload} title="Could not load API keys" />
      ) : (
        <Card>
          <CardContent className="p-0">
            {keysQuery.loading && keys.length === 0 ? (
              <TableSkeleton rows={4} columns={5} />
            ) : keys.length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title="No API keys"
                description="Create a key for the RazorBills backend, or another owner key for administration."
                action={
                  <Button size="sm" onClick={openCreate}>
                    <Plus className="size-4" aria-hidden="true" />
                    Create key
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => {
                    const status = keyStatus(key);
                    return (
                      <TableRow key={key.keyId}>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium">{key.name || 'Unnamed key'}</span>
                            <span className="flex items-center gap-1">
                              <span className="font-mono text-xs text-muted-foreground">{shortId(key.keyId, { head: 8, tail: 4 })}</span>
                              <CopyButton value={key.keyId} label="Copy id" />
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-xs flex-wrap gap-1">
                            {key.scopes.map((scope) => (
                              <Badge key={scope} variant={ownerScopes.includes(scope) ? 'warning' : 'muted'} className="font-mono text-[11px]">
                                {scope}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={status.tone}>{status.label}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {key.lastUsedAt ? formatRelative(key.lastUsedAt) : 'Never'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {key.expiresAt ? formatDateTime(key.expiresAt) : 'No expiry'}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setDetailKeyId(key.keyId)}>
                              Details
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRotateTarget(key)}
                              disabled={Boolean(key.revokedAt)}
                            >
                              <RefreshCw className="size-4" aria-hidden="true" />
                              Rotate
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Revoke ${key.name || key.keyId}`}
                              className="text-destructive hover:text-destructive"
                              onClick={() => setRevokeTarget(key)}
                              disabled={Boolean(key.revokedAt)}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create key */}
      <Dialog open={createOpen} onOpenChange={(open) => (!creating ? setCreateOpen(open) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>The plaintext key is shown once, immediately after creation.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitCreate}>
            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                maxLength={120}
                placeholder="razorbills-backend"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Scopes</Label>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setForm((current) => ({ ...current, scopes: [...SERVICE_PRESET] }))}>
                    Service preset
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setForm((current) => ({ ...current, scopes: [...availableScopes] }))}>
                    All scopes
                  </Button>
                </div>
              </div>
              <div className="grid gap-1.5 rounded-md border p-3 sm:grid-cols-2">
                {availableScopes.map((scope) => (
                  <label
                    key={scope}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent',
                      form.scopes.includes(scope) && 'bg-accent/60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[hsl(var(--primary))]"
                      checked={form.scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    <span className="font-mono text-xs">{scope}</span>
                    {ownerScopes.includes(scope) ? <Badge variant="warning">owner</Badge> : null}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-ttl">Expiry</Label>
              <Select value={form.ttl} onValueChange={(value) => setForm((current) => ({ ...current, ttl: value }))}>
                <SelectTrigger id="key-ttl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  <SelectItem value="365">365 days</SelectItem>
                  <SelectItem value={NO_EXPIRY}>No expiry</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.scopes.some((scope) => ownerScopes.includes(scope)) ? (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertDescription>
                  This key can administer the service. Only grant these scopes to a credential you personally control.
                </AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* One-time secret */}
      <Dialog open={Boolean(secret)} onOpenChange={() => setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>{secret?.warning ?? 'This value is shown once.'}</DialogDescription>
          </DialogHeader>
          <OneTimeSecret value={secret?.apiKey} />
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>I have stored the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Key details */}
      <Dialog open={Boolean(detailKeyId)} onOpenChange={(open) => (!open ? setDetailKeyId(null) : null)}>
        <DialogContent className="max-w-xl">
          {detailKey ? (
            <>
              <DialogHeader>
                <DialogTitle>{detailKey.name || 'Unnamed key'}</DialogTitle>
                <DialogDescription>
                  Public metadata for this credential. The secret is held only as a hash and can never be displayed again.
                </DialogDescription>
              </DialogHeader>

              {detailQuery.error ? (
                <ErrorState error={detailQuery.error} onRetry={() => detailQuery.reload()} title="Could not refresh this key" />
              ) : null}

              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                <div className="space-y-0.5 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Key id</dt>
                  <dd className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{detailKey.keyId}</span>
                    <CopyButton value={detailKey.keyId} label="Copy" />
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd>
                    <Badge variant={keyStatus(detailKey).tone}>{keyStatus(detailKey).label}</Badge>
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Tenant</dt>
                  <dd className="font-mono text-sm font-medium">{detailKey.tenantId}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Created</dt>
                  <dd className="text-sm font-medium">{formatDateTime(detailKey.createdAt)}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Last used</dt>
                  <dd className="text-sm font-medium">
                    {detailKey.lastUsedAt ? formatDateTime(detailKey.lastUsedAt) : 'Never'}
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Expires</dt>
                  <dd className="text-sm font-medium">
                    {detailKey.expiresAt ? formatDateTime(detailKey.expiresAt) : 'No expiry'}
                  </dd>
                </div>
                {detailKey.revokedAt ? (
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Revoked</dt>
                    <dd className="text-sm font-medium">{formatDateTime(detailKey.revokedAt)}</dd>
                  </div>
                ) : null}
                <div className="space-y-0.5 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Allowed instances</dt>
                  <dd className="text-sm font-medium">
                    {detailKey.allowedInstanceIds?.length
                      ? detailKey.allowedInstanceIds.join(', ')
                      : 'Any instance in the tenant'}
                  </dd>
                </div>
                <div className="space-y-0.5 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Scopes</dt>
                  <dd className="flex flex-wrap gap-1 pt-0.5">
                    {detailKey.scopes.map((scope) => (
                      <Badge
                        key={scope}
                        variant={ownerScopes.includes(scope) ? 'warning' : 'muted'}
                        className="font-mono text-[11px]"
                      >
                        {scope}
                      </Badge>
                    ))}
                  </dd>
                </div>
              </dl>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDetailKeyId(null)}>
                  Close
                </Button>
                <Button
                  variant="outline"
                  disabled={Boolean(detailKey.revokedAt)}
                  onClick={() => {
                    setRotateTarget(detailKey);
                    setDetailKeyId(null);
                  }}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Rotate
                </Button>
                <Button
                  variant="destructive"
                  disabled={Boolean(detailKey.revokedAt)}
                  onClick={() => {
                    setRevokeTarget(detailKey);
                    setDetailKeyId(null);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Revoke
                </Button>
              </DialogFooter>
            </>
          ) : detailQuery.error ? (
            <ErrorState error={detailQuery.error} onRetry={() => detailQuery.reload()} title="Could not load this key" />
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
        open={Boolean(rotateTarget)}
        onOpenChange={(open) => (!open && !rotating ? setRotateTarget(null) : null)}
        title="Rotate this key?"
        description={
          rotateTarget
            ? `A new secret will be issued for "${rotateTarget.name || shortId(rotateTarget.keyId)}" and the current secret will be revoked immediately.`
            : ''
        }
        confirmLabel="Rotate key"
        pending={rotating}
        onConfirm={confirmRotate}
      >
        <Alert variant="warning">
          <Info />
          <AlertDescription>Any service using the old secret will fail until it is updated with the new one.</AlertDescription>
        </Alert>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => (!open && !revoking ? setRevokeTarget(null) : null)}
        title="Revoke this key?"
        description={
          revokeTarget
            ? `"${revokeTarget.name || shortId(revokeTarget.keyId)}" will stop working immediately. This cannot be undone.`
            : ''
        }
        confirmLabel="Revoke key"
        destructive
        pending={revoking}
        onConfirm={confirmRevoke}
      >
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertDescription>Send a replacement key to the integrator before revoking the one in use.</AlertDescription>
        </Alert>
      </ConfirmDialog>
    </div>
  );
}
