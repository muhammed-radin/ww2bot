import { useMemo, useState } from 'react';
import { Filter, RefreshCw, ScrollText, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent } from '@/components/ui/card.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { StatusBadge } from '@/components/common/status-badge.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { instancesApi, uiApi } from '@/lib/api.js';
import { auditCategory, formatDateTime, formatRelative, shortId, titleCase } from '@/lib/format.js';

const PAGE_SIZE = 25;
const ALL = '__all__';

const CATEGORIES = ['authentication', 'connection', 'configuration', 'messaging', 'security'];

export default function LogsPage() {
  useDocumentTitle('Logs');

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);
  const instances = instancesQuery.data?.data?.items ?? [];

  const [draft, setDraft] = useState({ category: ALL, result: ALL, instanceId: ALL, action: '', since: '', until: '' });
  const [applied, setApplied] = useState(draft);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState(null);

  const eventsQuery = useApi(
    () =>
      uiApi.auditEvents({
        limit: PAGE_SIZE,
        offset,
        category: applied.category === ALL ? undefined : applied.category,
        result: applied.result === ALL ? undefined : applied.result,
        instanceId: applied.instanceId === ALL ? undefined : applied.instanceId,
        action: applied.action.trim() || undefined,
        since: applied.since ? new Date(`${applied.since}T00:00:00`).toISOString() : undefined,
        until: applied.until ? new Date(`${applied.until}T23:59:59.999`).toISOString() : undefined,
      }),
    [applied, offset],
  );

  const events = eventsQuery.data?.data?.items ?? [];
  const pagination = eventsQuery.data?.pagination ?? null;

  const hasFilters = useMemo(
    () =>
      applied.category !== ALL ||
      applied.result !== ALL ||
      applied.instanceId !== ALL ||
      applied.action.trim() !== '' ||
      applied.since !== '' ||
      applied.until !== '',
    [applied],
  );

  function applyFilters(event) {
    event.preventDefault();
    setApplied(draft);
    setOffset(0);
  }

  function resetFilters() {
    const cleared = { category: ALL, result: ALL, instanceId: ALL, action: '', since: '', until: '' };
    setDraft(cleared);
    setApplied(cleared);
    setOffset(0);
  }

  function instanceLabel(id) {
    const match = instances.find((item) => item.id === id);
    return match?.displayName || shortId(id);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Logs"
        description="Audit trail of authentication, connection, configuration and messaging events."
        actions={
          <Button variant="outline" size="sm" onClick={() => eventsQuery.reload()} disabled={eventsQuery.refetching}>
            <RefreshCw className={eventsQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4">
          <form className="space-y-4" onSubmit={applyFilters}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="log-category">Category</Label>
                <Select value={draft.category} onValueChange={(value) => setDraft((current) => ({ ...current, category: value }))}>
                  <SelectTrigger id="log-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All categories</SelectItem>
                    {CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {titleCase(category)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="log-result">Result</Label>
                <Select value={draft.result} onValueChange={(value) => setDraft((current) => ({ ...current, result: value }))}>
                  <SelectTrigger id="log-result">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any result</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="failure">Failure</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="log-instance">Instance</Label>
                <Select value={draft.instanceId} onValueChange={(value) => setDraft((current) => ({ ...current, instanceId: value }))}>
                  <SelectTrigger id="log-instance">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All instances</SelectItem>
                    {instances.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.displayName || shortId(item.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="log-action">Action</Label>
                <Input
                  id="log-action"
                  placeholder="e.g. instance.connect"
                  value={draft.action}
                  onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="log-since">From</Label>
                <Input
                  id="log-since"
                  type="date"
                  value={draft.since}
                  onChange={(event) => setDraft((current) => ({ ...current, since: event.target.value }))}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="log-until">To</Label>
                <Input
                  id="log-until"
                  type="date"
                  value={draft.until}
                  onChange={(event) => setDraft((current) => ({ ...current, until: event.target.value }))}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm">
                <Filter className="size-4" aria-hidden="true" />
                Apply filters
              </Button>
              {hasFilters ? (
                <Button type="button" size="sm" variant="ghost" onClick={resetFilters}>
                  <X className="size-4" aria-hidden="true" />
                  Clear
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {eventsQuery.error ? (
        <ErrorState error={eventsQuery.error} onRetry={eventsQuery.reload} title="Could not load the audit trail" />
      ) : (
        <Card>
          <CardContent className="p-0">
            {eventsQuery.loading && events.length === 0 ? (
              <TableSkeleton rows={8} columns={5} />
            ) : events.length === 0 ? (
              <EmptyState
                icon={hasFilters ? Search : ScrollText}
                title={hasFilters ? 'No events match these filters' : 'No audit events yet'}
                description={
                  hasFilters
                    ? 'Try widening the date range or clearing a filter.'
                    : 'Authentication, connection and configuration events will be recorded here.'
                }
                action={
                  hasFilters ? (
                    <Button size="sm" variant="outline" onClick={resetFilters}>
                      Clear filters
                    </Button>
                  ) : null
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Instance</TableHead>
                    <TableHead>Request</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow
                      key={event.id}
                      className="cursor-pointer"
                      onClick={() => setDetail(event)}
                      tabIndex={0}
                      onKeyDown={(keyEvent) => {
                        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                          keyEvent.preventDefault();
                          setDetail(event);
                        }
                      }}
                    >
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">{formatRelative(event.createdAt)}</span>
                          <span className="text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{event.action}</TableCell>
                      <TableCell>
                        <Badge variant="muted">{titleCase(auditCategory(event.action))}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge kind="result" status={event.result} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {event.instanceId ? instanceLabel(event.instanceId) : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {event.requestId ? shortId(event.requestId, { head: 8, tail: 4 }) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {pagination && events.length > 0 ? (
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  Showing {pagination.offset + 1}–{pagination.offset + pagination.returned}
                  {pagination.scanned ? ` of the ${pagination.scanned} most recent events scanned` : ''}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasMore}
                    onClick={() => setOffset(pagination.nextOffset ?? offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Dialog open={Boolean(detail)} onOpenChange={(open) => (!open ? setDetail(null) : null)}>
        <DialogContent>
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono text-sm">{detail.action}</DialogTitle>
                <DialogDescription>{formatDateTime(detail.createdAt)}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Result</dt>
                  <dd>
                    <StatusBadge kind="result" status={detail.result} />
                  </dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Category</dt>
                  <dd className="text-sm font-medium">{titleCase(auditCategory(detail.action))}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Actor key</dt>
                  <dd className="font-mono text-xs">{detail.actorKeyId ? shortId(detail.actorKeyId, { head: 8, tail: 4 }) : '—'}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Instance</dt>
                  <dd className="text-sm font-medium">{detail.instanceId ? instanceLabel(detail.instanceId) : '—'}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">IP address</dt>
                  <dd className="font-mono text-xs">{detail.ip ?? '—'}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">Request id</dt>
                  <dd className="font-mono text-xs">{detail.requestId ?? '—'}</dd>
                </div>
              </dl>
              {detail.metadata && Object.keys(detail.metadata).length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Details</p>
                  <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                    {JSON.stringify(detail.metadata, null, 2)}
                  </pre>
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
