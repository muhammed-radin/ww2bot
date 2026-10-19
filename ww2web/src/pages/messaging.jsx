import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, MessageSquare, RefreshCw, Send, Server } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert.jsx';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.jsx';
import { Textarea } from '@/components/ui/textarea.jsx';
import { ConfirmDialog } from '@/components/common/confirm-dialog.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { StatusBadge } from '@/components/common/status-badge.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { instancesApi, messagesApi, uiApi } from '@/lib/api.js';
import { formatDateTime, formatRelative, shortId } from '@/lib/format.js';

const ALL = '__all__';

export default function MessagingPage() {
  useDocumentTitle('Messaging');

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);
  const instances = instancesQuery.data?.data?.items ?? [];

  const [instanceFilter, setInstanceFilter] = useState(ALL);
  const deliveriesQuery = useApi(
    () => uiApi.deliveries({ instanceId: instanceFilter === ALL ? undefined : instanceFilter, limit: 100 }),
    [instanceFilter],
    { pollMs: 20000 },
  );
  const deliveries = deliveriesQuery.data?.data?.items ?? [];

  const [composeOpen, setComposeOpen] = useState(false);
  const [form, setForm] = useState({ instanceId: '', to: '', text: '', idempotencyKey: '' });
  const [pendingSend, setPendingSend] = useState(null);
  const [sending, setSending] = useState(false);

  const sendableInstances = useMemo(
    () => instances.filter((item) => item.status === 'ready' || item.status === 'authenticated'),
    [instances],
  );

  function openCompose() {
    const preferred = sendableInstances[0] ?? instances[0] ?? null;
    setForm({ instanceId: preferred?.id ?? '', to: '', text: '', idempotencyKey: '' });
    setComposeOpen(true);
  }

  function reviewSend(event) {
    event.preventDefault();
    if (!form.instanceId) {
      toast.error('Select an instance to send from');
      return;
    }
    const raw = form.to.trim();
    const isChatId = raw.includes('@');
    if (isChatId ? !/^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{2,32}$/.test(raw) : raw.replace(/\D/g, '').length < 7) {
      toast.error(isChatId ? 'Enter a valid chat id, for example 131355503402@c.us' : 'Enter the recipient in international format');
      return;
    }
    if (form.text.trim().length === 0) {
      toast.error('Enter a message body');
      return;
    }
    setComposeOpen(false);
    setPendingSend({
      instanceId: form.instanceId,
      to: isChatId ? raw : raw.replace(/\D/g, ''),
      text: form.text,
      idempotencyKey: form.idempotencyKey.trim() || undefined,
    });
  }

  async function confirmSend() {
    if (!pendingSend) return;
    setSending(true);
    try {
      const { data } = await messagesApi.send(pendingSend);
      const status = data?.status ?? data?.message?.status ?? 'accepted';
      toast.success('Message submitted', {
        description:
          status === 'sent'
            ? 'The linked device handed the message to WhatsApp. Delivery is not independently confirmed.'
            : 'The provider accepted the request. Handset delivery is not confirmed.',
      });
      setPendingSend(null);
      setForm({ instanceId: '', to: '', text: '', idempotencyKey: '' });
      deliveriesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('The message could not be sent', { description: error.message });
    } finally {
      setSending(false);
    }
  }

  const instanceLabel = (id) => {
    const match = instances.find((item) => item.id === id);
    return match?.displayName || shortId(id);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messaging"
        description="Outbound delivery activity recorded by the gateway, with an optional test send."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => deliveriesQuery.reload()} disabled={deliveriesQuery.refetching}>
              <RefreshCw className={deliveriesQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
              Refresh
            </Button>
            <Button size="sm" onClick={openCompose} disabled={instances.length === 0}>
              <Send className="size-4" aria-hidden="true" />
              Send test message
            </Button>
          </>
        }
      />

      <Alert variant="muted">
        <Info />
        <AlertDescription>
          This page lists delivery metadata only — recipient, status and provider identifiers. It never shows chat history or message
          bodies, and it does not support bulk or campaign messaging.
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="w-full space-y-2 sm:max-w-xs">
            <Label htmlFor="delivery-instance">Filter by instance</Label>
            <Select value={instanceFilter} onValueChange={setInstanceFilter}>
              <SelectTrigger id="delivery-instance">
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
          <p className="text-xs text-muted-foreground">{deliveries.length} recent record{deliveries.length === 1 ? '' : 's'}</p>
        </CardContent>
      </Card>

      {deliveriesQuery.error ? (
        <ErrorState error={deliveriesQuery.error} onRetry={deliveriesQuery.reload} title="Could not load delivery activity" />
      ) : (
        <Card>
          <CardContent className="p-0">
            {deliveriesQuery.loading && deliveries.length === 0 ? (
              <TableSkeleton rows={5} columns={5} />
            ) : deliveries.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No deliveries recorded"
                description="Outbound messages sent through the RazorBills API will appear here with their status."
                action={
                  instances.length === 0 ? (
                    <Button asChild size="sm" variant="outline">
                      <Link to="/instances">
                        <Server className="size-4" aria-hidden="true" />
                        Create an instance
                      </Link>
                    </Button>
                  ) : null
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Instance</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Provider message id</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">{formatRelative(delivery.createdAt)}</span>
                          <span className="text-xs text-muted-foreground">{formatDateTime(delivery.createdAt)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{instanceLabel(delivery.instanceId)}</TableCell>
                      <TableCell className="font-mono text-sm">{delivery.recipientMasked ?? '—'}</TableCell>
                      <TableCell>
                        <StatusBadge kind="delivery" status={delivery.status} />
                        {delivery.errorCode ? (
                          <p className="mt-1 text-xs text-muted-foreground">Code: {delivery.errorCode}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {delivery.providerMessageId ? shortId(delivery.providerMessageId, { head: 12, tail: 6 }) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={composeOpen} onOpenChange={(open) => (!open ? setComposeOpen(false) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a test message</DialogTitle>
            <DialogDescription>
              Sends one text message to a single recipient. Review the details before confirming.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={reviewSend}>
            <div className="space-y-2">
              <Label htmlFor="send-instance">Send from</Label>
              <Select value={form.instanceId} onValueChange={(value) => setForm((current) => ({ ...current, instanceId: value }))}>
                <SelectTrigger id="send-instance">
                  <SelectValue placeholder="Select an instance" />
                </SelectTrigger>
                <SelectContent>
                  {instances.map((item) => (
                    <SelectItem key={item.id} value={item.id} disabled={item.status !== 'ready' && item.status !== 'authenticated'}>
                      {item.displayName || shortId(item.id)}
                      {item.status !== 'ready' && item.status !== 'authenticated' ? ' — not connected' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sendableInstances.length === 0 ? (
                <p className="text-xs text-warning">No instance is currently connected. Connect one first.</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="send-to">Recipient (phone number or chat id)</Label>
              <Input
                id="send-to"
                autoComplete="off"
                placeholder="15551234567 or 131355503402@c.us"
                value={form.to}
                onChange={(event) => setForm((current) => ({ ...current, to: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                A phone number in international format, or a full WhatsApp chat id such as <span className="font-mono">131355503402@c.us</span>.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="send-text">Message</Label>
              <Textarea
                id="send-text"
                maxLength={4096}
                placeholder="Test message from the administration dashboard."
                value={form.text}
                onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">{form.text.length}/4096 characters</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="send-idempotency">Idempotency key (optional)</Label>
              <Input
                id="send-idempotency"
                maxLength={200}
                placeholder="test-0001"
                value={form.idempotencyKey}
                onChange={(event) => setForm((current) => ({ ...current, idempotencyKey: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">Repeat sends with the same key are de-duplicated by the gateway.</p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setComposeOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                <Send className="size-4" aria-hidden="true" />
                Review and send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingSend)}
        onOpenChange={(open) => (!open && !sending ? setPendingSend(null) : null)}
        title="Send this message now?"
        confirmLabel="Send message"
        pending={sending}
        onConfirm={confirmSend}
        description={
          pendingSend
            ? `To ${pendingSend.to} from ${instanceLabel(pendingSend.instanceId)}. This immediately submits the message through the connector.`
            : ''
        }
      >
        {pendingSend ? (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Message</p>
            <p className="mt-1 whitespace-pre-wrap break-words">{pendingSend.text}</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
