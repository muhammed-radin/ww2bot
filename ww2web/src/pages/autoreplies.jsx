import { useEffect, useMemo, useState } from 'react';
import { Bot, MessageSquareReply, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
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
import { Switch } from '@/components/ui/switch.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.jsx';
import { Textarea } from '@/components/ui/textarea.jsx';
import { ConfirmDialog } from '@/components/common/confirm-dialog.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { instancesApi } from '@/lib/api.js';
import { formatRelative, shortId, titleCase } from '@/lib/format.js';

const MATCH_TYPES = [
  { value: 'exact', label: 'Exactly equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'prefix', label: 'Starts with' },
  { value: 'regex', label: 'Matches regular expression' },
];

const EMPTY_FORM = {
  name: '',
  matchType: 'exact',
  matchValue: '',
  caseSensitive: false,
  replyText: '',
  cooldownSeconds: 0,
  enabled: true,
};

function ruleToForm(rule) {
  return {
    name: rule.name ?? '',
    matchType: rule.match?.type ?? 'exact',
    matchValue: rule.match?.value ?? '',
    caseSensitive: Boolean(rule.match?.caseSensitive),
    replyText: rule.reply?.text ?? '',
    cooldownSeconds: rule.cooldownSeconds ?? 0,
    enabled: rule.enabled !== false,
  };
}

function describeMatch(match) {
  const label = MATCH_TYPES.find((entry) => entry.value === match?.type)?.label ?? match?.type ?? 'matches';
  return `${label} “${match?.value ?? ''}”${match?.caseSensitive ? ' (case-sensitive)' : ''}`;
}

export default function AutoRepliesPage() {
  useDocumentTitle('Auto-replies');

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);
  const instances = instancesQuery.data?.data?.items ?? [];

  const [selectedId, setSelectedId] = useState(null);
  useEffect(() => {
    if (!selectedId && instances.length > 0) setSelectedId(instances[0].id);
  }, [instances, selectedId]);
  const selected = useMemo(() => instances.find((item) => item.id === selectedId) ?? null, [instances, selectedId]);

  const rulesQuery = useApi(
    () => instancesApi.autoReplies(selectedId),
    [selectedId],
    { immediate: Boolean(selectedId) },
  );
  const rules = rulesQuery.data?.data?.items ?? [];
  const limitations = rulesQuery.data?.data?.limitations ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(rule) {
    setEditing(rule);
    setForm(ruleToForm(rule));
    setDialogOpen(true);
  }

  async function submitRule(event) {
    event.preventDefault();
    if (!selectedId) return;
    const value = form.matchValue.trim();
    const text = form.replyText.trim();
    if (value.length === 0) {
      toast.error('Enter what the incoming message should match');
      return;
    }
    if (text.length === 0) {
      toast.error('Enter the reply to send');
      return;
    }
    const payload = {
      name: form.name.trim() || null,
      enabled: form.enabled,
      match: { type: form.matchType, value, caseSensitive: form.caseSensitive },
      reply: { text },
      cooldownSeconds: Number(form.cooldownSeconds) || 0,
    };
    setSaving(true);
    try {
      if (editing) {
        await instancesApi.updateAutoReply(selectedId, editing.id, payload);
        toast.success('Rule updated');
      } else {
        await instancesApi.createAutoReply(selectedId, payload);
        toast.success('Rule created');
      }
      setDialogOpen(false);
      setEditing(null);
      await rulesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('The rule could not be saved', { description: error.message });
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule, enabled) {
    if (!selectedId) return;
    setBusyRuleId(rule.id);
    try {
      await instancesApi.updateAutoReply(selectedId, rule.id, { enabled });
      await rulesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('The rule could not be updated', { description: error.message });
    } finally {
      setBusyRuleId(null);
    }
  }

  async function confirmDelete() {
    if (!selectedId || !pendingDelete) return;
    setDeleting(true);
    try {
      await instancesApi.deleteAutoReply(selectedId, pendingDelete.id);
      toast.success('Rule deleted');
      setPendingDelete(null);
      await rulesQuery.reload({ silent: true });
    } catch (error) {
      toast.error('The rule could not be deleted', { description: error.message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Auto-replies"
        description="Reply automatically when an incoming message matches a rule. Rules run inside the gateway; nothing is sent while the instance is disconnected."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => rulesQuery.reload()}
              disabled={!selectedId || rulesQuery.refetching}
            >
              <RefreshCw className={rulesQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
              Refresh
            </Button>
            <Button size="sm" onClick={openCreate} disabled={!selectedId}>
              <Plus className="size-4" aria-hidden="true" />
              New rule
            </Button>
          </>
        }
      />

      <Alert variant="muted">
        <Bot />
        <AlertTitle>How automatic replies work</AlertTitle>
        <AlertDescription>
          <ul className="list-disc space-y-1 pl-4">
            <li>Only incoming messages are matched, so a reply can never trigger another reply.</li>
            <li>Rules are evaluated in order; the first matching enabled rule sends its reply.</li>
            <li>Direct chats only — group chats are never auto-replied.</li>
            <li>A per-chat cooldown (optional) limits how often a rule replies in the same conversation.</li>
          </ul>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Instance</CardTitle>
          <CardDescription>Rules are stored per instance and use that instance&apos;s linked session to reply.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full space-y-2 sm:max-w-sm">
            <Label htmlFor="autoreply-instance">Instance</Label>
            <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
              <SelectTrigger id="autoreply-instance">
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
              <Badge variant="muted">{titleCase(selected.connector)}</Badge>
              <span className="font-mono">{shortId(selected.id)}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {!selectedId ? (
        <EmptyState
          icon={Bot}
          title="No instance selected"
          description="Create an instance first, then add rules that reply to incoming messages."
        />
      ) : rulesQuery.loading && rules.length === 0 ? (
        <Card>
          <TableSkeleton rows={4} columns={5} />
        </Card>
      ) : rulesQuery.error ? (
        <ErrorState
          error={rulesQuery.error}
          onRetry={() => rulesQuery.reload()}
          title="Could not load auto-reply rules"
        />
      ) : rules.length === 0 ? (
        <Card>
          <EmptyState
            icon={MessageSquareReply}
            title="No rules yet"
            description="Add a rule such as matching “/hi” and replying “Hi, how are you”."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" aria-hidden="true" />
                New rule
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Reply</TableHead>
                  <TableHead>Cooldown</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={rule.enabled !== false}
                          disabled={busyRuleId === rule.id}
                          onCheckedChange={(checked) => toggleRule(rule, checked)}
                          aria-label={`Enable rule ${rule.name || rule.id}`}
                        />
                        <div className="flex flex-col">
                          <span className="font-medium">{rule.name || 'Untitled rule'}</span>
                          <span className="font-mono text-xs text-muted-foreground">{shortId(rule.id)}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[16rem] text-sm">
                      <span className="text-muted-foreground">{describeMatch(rule.match)}</span>
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-sm" title={rule.reply?.text}>
                      {rule.reply?.text}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {rule.cooldownSeconds > 0 ? `${rule.cooldownSeconds}s` : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex flex-col gap-0.5">
                        <span>{rule.stats?.replies ?? 0} replies · {rule.stats?.matches ?? 0} matches</span>
                        {rule.stats?.lastMatchedAt ? (
                          <span className="text-xs">Last match {formatRelative(rule.stats.lastMatchedAt)}</span>
                        ) : null}
                        {rule.stats?.failures > 0 ? (
                          <span className="text-xs text-destructive">{rule.stats.failures} failed</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(rule)}>
                          <Pencil className="size-4" aria-hidden="true" />
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setPendingDelete(rule)}>
                          <Trash2 className="size-4" aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {limitations.length > 0 ? (
        <Alert variant="muted">
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={(open) => (!saving ? setDialogOpen(open) : undefined)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit rule' : 'New automatic-reply rule'}</DialogTitle>
            <DialogDescription>
              When an incoming direct message matches, the gateway sends the reply from this instance&apos;s linked session.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submitRule}>
            <div className="space-y-2">
              <Label htmlFor="rule-name">Name (optional)</Label>
              <Input
                id="rule-name"
                value={form.name}
                maxLength={80}
                placeholder="Greeting"
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="rule-match-type">Match type</Label>
                <Select
                  value={form.matchType}
                  onValueChange={(value) => setForm((current) => ({ ...current, matchType: value }))}
                >
                  <SelectTrigger id="rule-match-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MATCH_TYPES.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rule-cooldown">Cooldown (seconds)</Label>
                <Input
                  id="rule-cooldown"
                  type="number"
                  min={0}
                  max={86400}
                  value={form.cooldownSeconds}
                  onChange={(event) => setForm((current) => ({ ...current, cooldownSeconds: event.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rule-match-value">Incoming message matches</Label>
              <Input
                id="rule-match-value"
                value={form.matchValue}
                maxLength={500}
                placeholder="/hi"
                onChange={(event) => setForm((current) => ({ ...current, matchValue: event.target.value }))}
              />
              <div className="flex items-center gap-2 pt-1">
                <Switch
                  id="rule-case"
                  checked={form.caseSensitive}
                  onCheckedChange={(checked) => setForm((current) => ({ ...current, caseSensitive: checked }))}
                />
                <Label htmlFor="rule-case" className="font-normal text-muted-foreground">
                  Case-sensitive matching
                </Label>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rule-reply">Reply to send</Label>
              <Textarea
                id="rule-reply"
                value={form.replyText}
                maxLength={4096}
                rows={3}
                placeholder="Hi, how are you"
                onChange={(event) => setForm((current) => ({ ...current, replyText: event.target.value }))}
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="rule-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: checked }))}
              />
              <Label htmlFor="rule-enabled" className="font-normal">
                Rule enabled
              </Label>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => (!open ? setPendingDelete(null) : undefined)}
        title="Delete this rule?"
        description={
          pendingDelete
            ? `“${pendingDelete.name || pendingDelete.match?.value}” will stop replying. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete rule"
        destructive
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
