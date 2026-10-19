import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Database,
  Inbox,
  MessageSquare,
  Radio,
  RefreshCw,
  Server,
  Users,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.jsx';
import { CopyButton } from '@/components/common/copy-button.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { TableSkeleton } from '@/components/common/loading.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useConnectionEvents } from '@/hooks/use-connection-events.js';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { instancesApi } from '@/lib/api.js';
import { formatDateTime, formatRelative, shortId, titleCase } from '@/lib/format.js';
import { cn } from '@/lib/utils.js';

const PAGE_SIZE = 25;

/**
 * Cursor paging: the API hands back `pagination.nextCursor` for the next page.
 * The stack is scoped to the selected instance, so switching instances starts
 * at the first page immediately instead of briefly reusing the old cursor.
 */
function useCursorStack(scope) {
  const [state, setState] = useState({ scope: null, stack: [] });
  const stack = state.scope === scope ? state.stack : [];
  const update = (change) =>
    setState((current) => {
      const base = current.scope === scope ? current.stack : [];
      return { scope, stack: change(base) };
    });

  return {
    cursor: stack.length > 0 ? stack[stack.length - 1] : undefined,
    depth: stack.length,
    next: (nextCursor) => update((base) => [...base, nextCursor]),
    previous: () => update((base) => base.slice(0, -1)),
    reset: () => setState({ scope, stack: [] }),
  };
}

function PageControls({ pagination, page }) {
  if (!pagination) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
      <p className="text-xs text-muted-foreground">
        {pagination.returned ?? 0} item{(pagination.returned ?? 0) === 1 ? '' : 's'} on this page
        {page.depth > 0 ? ` · page ${page.depth + 1}` : ''}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={page.reset} disabled={page.depth === 0}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          First
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => pagination.nextCursor && page.next(pagination.nextCursor)}
          disabled={!pagination.hasMore || !pagination.nextCursor}
        >
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function Limitations({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <Alert variant="muted">
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {items.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ChatDialog({ instanceId, chat, onClose }) {
  const [cursorStack, setCursorStack] = useState([]);
  const cursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  const detailQuery = useApi(() => instancesApi.chat(instanceId, chat.chatId), [instanceId, chat.chatId]);
  const messagesQuery = useApi(
    () => instancesApi.messages(instanceId, chat.chatId, { limit: 50, cursor }),
    [instanceId, chat.chatId, cursor],
  );

  const detail = detailQuery.data?.data ?? null;
  const messages = messagesQuery.data?.data?.items ?? [];
  const messagesPagination = messagesQuery.data?.pagination ?? null;
  const limitations = [...(detail?.limitations ?? []), ...(messagesQuery.data?.data?.limitations ?? [])];

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{detail?.displayName || chat.displayName || chat.chatId}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Badge variant={chat.isGroup ? 'info' : 'muted'}>{chat.isGroup ? 'Group' : 'Direct chat'}</Badge>
            <span className="font-mono text-xs">{chat.chatId}</span>
            <CopyButton value={chat.chatId} label="Copy id" />
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <p className="text-muted-foreground">
              Last message: <span className="text-foreground">{formatDateTime(detail?.lastMessageAt ?? chat.lastMessageAt)}</span>
            </p>
            {typeof detail?.messageCount === 'number' ? (
              <p className="text-muted-foreground">
                Retained messages: <span className="text-foreground">{detail.messageCount}</span>
              </p>
            ) : null}
            {detail?.source ? (
              <p className="text-muted-foreground">
                Source: <span className="font-mono text-xs text-foreground">{detail.source}</span>
              </p>
            ) : null}
          </div>

          <Limitations items={limitations} />

          {messagesQuery.error ? (
            <ErrorState error={messagesQuery.error} onRetry={() => messagesQuery.reload()} title="Could not read this chat's messages" />
          ) : messagesQuery.loading && messages.length === 0 ? (
            <TableSkeleton rows={4} columns={2} />
          ) : messages.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No messages available"
              description="This connector returned no messages for this chat. History may be unavailable, or retention may be disabled."
            />
          ) : (
            <ul className="space-y-3">
              {messages.map((message) => {
                const direction = message.direction ?? (message.fromMe ? 'outbound' : 'inbound');
                const body = message.body ?? message.caption ?? null;
                return (
                  <li
                    key={message.id ?? `${message.timestamp}-${direction}`}
                    className={cn(
                      'rounded-lg border p-3',
                      direction === 'outbound' ? 'border-primary/25 bg-primary/5' : 'bg-muted/30',
                    )}
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={direction === 'outbound' ? 'info' : 'muted'}>{titleCase(direction)}</Badge>
                      <Badge variant="outline">{titleCase(message.type ?? 'unknown')}</Badge>
                      <span>{formatDateTime(message.timestamp)}</span>
                      {message.hasMedia ? <Badge variant="warning">Media</Badge> : null}
                      {message.ack !== null && message.ack !== undefined ? <span>ack {message.ack}</span> : null}
                    </div>
                    {body ? (
                      <p className="whitespace-pre-wrap break-words text-sm">{body}</p>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">
                        No text content{message.type ? ` (${message.type})` : ''}.
                      </p>
                    )}
                    <p className="mt-1.5 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                      {message.from ? <span className="font-mono">from {message.from}</span> : null}
                      {message.to ? <span className="font-mono">to {message.to}</span> : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          {messagesPagination ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                {messages.length} message{messages.length === 1 ? '' : 's'} in this window
                {cursorStack.length > 0 ? ` · page ${cursorStack.length + 1}` : ''}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCursorStack((current) => current.slice(0, -1))}
                  disabled={cursorStack.length === 0 || messagesQuery.loading}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  Newer
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => messagesPagination.nextCursor && setCursorStack((current) => [...current, messagesPagination.nextCursor])}
                  disabled={!messagesPagination.hasMore || !messagesPagination.nextCursor || messagesQuery.loading}
                >
                  Older
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function DataPage() {
  useDocumentTitle('Data');

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), []);
  const instances = instancesQuery.data?.data?.items ?? [];

  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('chats');
  const [activeChat, setActiveChat] = useState(null);

  const chatsPage = useCursorStack(selectedId);
  const contactsPage = useCursorStack(selectedId);

  useEffect(() => {
    if (instances.length === 0) {
      if (selectedId) setSelectedId(null);
      return;
    }
    if (!selectedId || !instances.some((item) => item.id === selectedId)) setSelectedId(instances[0].id);
  }, [instances, selectedId]);

  // Changing instance must close an open conversation; the cursor stacks reset
  // themselves because they are scoped to the selected instance.
  useEffect(() => {
    setActiveChat(null);
  }, [selectedId]);

  const selected = useMemo(() => instances.find((item) => item.id === selectedId) ?? null, [instances, selectedId]);

  const capabilitiesQuery = useApi(() => instancesApi.capabilities(selectedId), [selectedId], {
    immediate: Boolean(selectedId),
  });
  // Guard against a stale capability document from the previously selected
  // instance: the response names the instance it describes.
  const capabilities =
    capabilitiesQuery.data?.data?.instanceId === selectedId ? capabilitiesQuery.data.data.capabilities : null;
  const chatsSupported = Boolean(capabilities?.listChats);
  const contactsSupported = Boolean(capabilities?.listContacts);

  const chatsQuery = useApi(
    async () => {
      const result = await instancesApi.chats(selectedId, { limit: PAGE_SIZE, cursor: chatsPage.cursor });
      return { ...result, instanceId: selectedId };
    },
    [selectedId, chatsPage.cursor, chatsSupported],
    { immediate: Boolean(selectedId) && chatsSupported },
  );
  const contactsQuery = useApi(
    async () => {
      const result = await instancesApi.contacts(selectedId, { limit: PAGE_SIZE, cursor: contactsPage.cursor });
      return { ...result, instanceId: selectedId };
    },
    [selectedId, contactsPage.cursor, contactsSupported],
    { immediate: Boolean(selectedId) && contactsSupported },
  );

  // Only show a page that belongs to the selected instance; a response for the
  // previous one must never flash while the next request is in flight.
  const chatsPayload = chatsQuery.data?.instanceId === selectedId ? chatsQuery.data : null;
  const contactsPayload = contactsQuery.data?.instanceId === selectedId ? contactsQuery.data : null;
  const chats = chatsPayload?.data?.items ?? [];
  const contacts = contactsPayload?.data?.items ?? [];

  // Live messages tab: SSE for incoming/outgoing notifications, REST for the
  // recorded history. The two compose into a live feed with content.
  const [liveDirection, setLiveDirection] = useState('all');
  const historyQuery = useApi(
    async () => {
      const result = await instancesApi.recordedMessages(selectedId, {
        limit: 50,
        direction: liveDirection === 'all' ? undefined : liveDirection,
      });
      return { ...result, instanceId: selectedId };
    },
    [selectedId, liveDirection],
    { immediate: Boolean(selectedId) },
  );
  const historyPayload = historyQuery.data?.instanceId === selectedId ? historyQuery.data : null;
  const historyItems = historyPayload?.data?.items ?? [];
  const { events: liveEvents, streamState } = useConnectionEvents(selectedId, {
    enabled: Boolean(selectedId) && tab === 'live',
  });
  const liveMessages = liveEvents.filter(
    (event) => event.type === 'message.received' || event.type === 'message.sent',
  );

  if (instancesQuery.loading && instances.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Data" description="Read-only chats, messages and contacts from the selected instance." />
        <Card>
          <TableSkeleton rows={6} columns={3} />
        </Card>
      </div>
    );
  }

  if (instancesQuery.error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Data" description="Read-only chats, messages and contacts from the selected instance." />
        <ErrorState error={instancesQuery.error} onRetry={instancesQuery.reload} title="Could not load instances" />
      </div>
    );
  }

  if (instances.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Data" description="Read-only chats, messages and contacts from the selected instance." />
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Server}
              title="No instances yet"
              description="Create and connect an instance before reading its chats and contacts."
              action={
                <Button asChild size="sm">
                  <Link to="/instances">Create an instance</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data"
        description="Read-only chats, messages and contacts, served by the selected connector. Nothing on this page is written back to WhatsApp."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => (tab === 'chats' ? chatsQuery.reload() : contactsQuery.reload())}
            disabled={tab === 'chats' ? chatsQuery.refetching : contactsQuery.refetching}
          >
            <RefreshCw
              className={(tab === 'chats' ? chatsQuery.refetching : contactsQuery.refetching) ? 'size-4 animate-spin' : 'size-4'}
              aria-hidden="true"
            />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Instance</CardTitle>
          <CardDescription>History is read live from the connector for this instance.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full space-y-2 sm:max-w-sm">
            <Label htmlFor="data-instance">Instance</Label>
            <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
              <SelectTrigger id="data-instance">
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

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="chats">
            <Inbox className="mr-2 size-4" aria-hidden="true" />
            Chats
          </TabsTrigger>
          <TabsTrigger value="contacts">
            <Users className="mr-2 size-4" aria-hidden="true" />
            Contacts
          </TabsTrigger>
          <TabsTrigger value="live">
            <Radio className="mr-2 size-4" aria-hidden="true" />
            Live
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chats" className="space-y-4">
          {capabilitiesQuery.loading && !capabilities ? (
            <Card>
              <TableSkeleton rows={4} columns={4} />
            </Card>
          ) : capabilitiesQuery.error ? (
            <ErrorState
              error={capabilitiesQuery.error}
              onRetry={() => capabilitiesQuery.reload()}
              title="Could not read this connector's capabilities"
            />
          ) : !chatsSupported ? (
            <Alert variant="muted">
              <Database />
              <AlertTitle>Chats are not available for this instance</AlertTitle>
              <AlertDescription>
                <p>
                  {selected?.connector === 'cloud_api'
                    ? 'The Cloud API can only expose chats for messages this gateway retained, and retention is off for this instance.'
                    : 'This connector does not support reading chats.'}
                </p>
                {capabilities?.limitations?.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-4">
                    {capabilities.limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : chatsQuery.error ? (
            <ErrorState error={chatsQuery.error} onRetry={() => chatsQuery.reload()} title="Could not load chats" />
          ) : (
            <Card>
              <CardContent className="p-0">
                {chatsQuery.loading && chats.length === 0 ? (
                  <TableSkeleton rows={5} columns={4} />
                ) : chats.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="No chats"
                    description="The connector returned no chats for this instance. History may be empty or unavailable."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Chat</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Unread</TableHead>
                        <TableHead>Last message</TableHead>
                        <TableHead className="text-right">Messages</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {chats.map((chat) => (
                        <TableRow key={chat.chatId} className="cursor-pointer" onClick={() => setActiveChat(chat)}>
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <span className="font-medium">{chat.displayName || 'Unnamed chat'}</span>
                              <span className="font-mono text-xs text-muted-foreground">{chat.chatId}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              <Badge variant={chat.isGroup ? 'info' : 'muted'}>{chat.isGroup ? 'Group' : 'Direct'}</Badge>
                              {chat.archived ? <Badge variant="outline">Archived</Badge> : null}
                              {chat.pinned ? <Badge variant="outline">Pinned</Badge> : null}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground tabular-nums">{chat.unreadCount ?? 0}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{formatRelative(chat.lastMessageAt)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                setActiveChat(chat);
                              }}
                            >
                              Open
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <PageControls pagination={chatsPayload?.pagination} page={chatsPage} />
              </CardContent>
            </Card>
          )}

          <Limitations items={chatsPayload?.data?.limitations} />
        </TabsContent>

        <TabsContent value="contacts" className="space-y-4">
          {capabilitiesQuery.loading && !capabilities ? (
            <Card>
              <TableSkeleton rows={4} columns={4} />
            </Card>
          ) : capabilitiesQuery.error ? (
            <ErrorState
              error={capabilitiesQuery.error}
              onRetry={() => capabilitiesQuery.reload()}
              title="Could not read this connector's capabilities"
            />
          ) : !contactsSupported ? (
            <Alert variant="muted">
              <Users />
              <AlertTitle>Contacts are not available for this instance</AlertTitle>
              <AlertDescription>
                This connector does not expose a contact list. The Cloud API provides no contact directory at all.
              </AlertDescription>
            </Alert>
          ) : contactsQuery.error ? (
            <ErrorState error={contactsQuery.error} onRetry={() => contactsQuery.reload()} title="Could not load contacts" />
          ) : (
            <Card>
              <CardContent className="p-0">
                {contactsQuery.loading && contacts.length === 0 ? (
                  <TableSkeleton rows={5} columns={4} />
                ) : contacts.length === 0 ? (
                  <EmptyState icon={Users} title="No contacts" description="The connector returned no contacts for this instance." />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Number</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Contact id</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contacts.map((contact) => (
                        <TableRow key={contact.contactId}>
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <span className="font-medium">{contact.name || contact.pushname || 'Unnamed contact'}</span>
                              {contact.shortName ? (
                                <span className="text-xs text-muted-foreground">{contact.shortName}</span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-sm">{contact.number ?? '—'}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {contact.isBusiness ? <Badge variant="info">Business</Badge> : null}
                              {contact.isEnterprise ? <Badge variant="outline">Enterprise</Badge> : null}
                              {contact.isMyContact ? <Badge variant="muted">In contacts</Badge> : null}
                              {!contact.isBusiness && !contact.isEnterprise && !contact.isMyContact ? (
                                <span className="text-sm text-muted-foreground">—</span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{contact.contactId}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <PageControls pagination={contactsPayload?.pagination} page={contactsPage} />
              </CardContent>
            </Card>
          )}

          <Limitations items={contactsPayload?.data?.limitations} />
        </TabsContent>

        <TabsContent value="live" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <div className="space-y-1">
                <CardTitle>Live message stream</CardTitle>
                <CardDescription>
                  Incoming and outgoing messages as the connector reports them over the event stream.
                </CardDescription>
              </div>
              <Badge variant={streamState === 'open' ? 'success' : 'muted'}>{streamState}</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {liveMessages.length === 0 ? (
                <EmptyState
                  icon={Radio}
                  title="Waiting for messages"
                  description="New incoming and outgoing messages appear here while this page is open."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Direction</TableHead>
                      <TableHead>Chat</TableHead>
                      <TableHead>Body</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {liveMessages.map((event) => (
                      <TableRow key={event.key}>
                        <TableCell>
                          <Badge variant={event.type === 'message.sent' ? 'success' : 'info'}>
                            {event.type === 'message.sent' ? 'Outbound' : 'Inbound'}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {event.data.chatId ?? '—'}
                        </TableCell>
                        <TableCell className="max-w-[24rem] text-sm">
                          {event.data.body ? (
                            <span className="line-clamp-2 whitespace-pre-wrap break-words">{event.data.body}</span>
                          ) : (
                            <span className="text-muted-foreground">No content in this event</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{event.data.type ?? '—'}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDateTime(event.at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1">
                <CardTitle>Recorded history</CardTitle>
                <CardDescription>
                  Newest first. Bodies are returned when retention is enabled for the instance; otherwise the live buffer
                  (messages seen since the connector started) is used.
                </CardDescription>
              </div>
              <div className="flex items-end gap-2">
                <div className="w-40 space-y-2">
                  <Label htmlFor="live-direction">Direction</Label>
                  <Select value={liveDirection} onValueChange={setLiveDirection}>
                    <SelectTrigger id="live-direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="inbound">Inbound</SelectItem>
                      <SelectItem value="outbound">Outbound</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => historyQuery.reload()}
                  disabled={historyQuery.refetching}
                >
                  <RefreshCw className={historyQuery.refetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {historyQuery.loading && historyItems.length === 0 ? (
                <TableSkeleton rows={4} columns={5} />
              ) : historyQuery.error ? (
                <ErrorState
                  error={historyQuery.error}
                  onRetry={() => historyQuery.reload()}
                  title="Could not load recorded messages"
                />
              ) : historyItems.length === 0 ? (
                <EmptyState
                  icon={MessageSquare}
                  title="No recorded messages"
                  description="Enable retention to persist message content, or keep the connector running to fill the live buffer."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Direction</TableHead>
                      <TableHead>Chat</TableHead>
                      <TableHead>Body</TableHead>
                      <TableHead>Content</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyItems.map((message) => (
                      <TableRow key={message.storedId ?? message.id}>
                        <TableCell>
                          <Badge variant={message.direction === 'outbound' ? 'success' : 'info'}>
                            {titleCase(message.direction ?? 'unknown')}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{message.chatId}</TableCell>
                        <TableCell className="max-w-[24rem] text-sm">
                          {message.body ? (
                            <span className="line-clamp-2 whitespace-pre-wrap break-words">{message.body}</span>
                          ) : (
                            <span className="text-muted-foreground">Not retained</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={message.contentRetained ? 'success' : 'muted'}>
                            {message.contentRetained ? 'Retained' : 'Metadata only'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDateTime(message.timestamp)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Limitations items={historyPayload?.data?.limitations} />
        </TabsContent>
      </Tabs>

      <Alert variant="warning">
        <AlertTriangle />
        <AlertTitle>Owner-only read access</AlertTitle>
        <AlertDescription>
          Chats, message bodies and contact numbers come from the linked WhatsApp account. The Cloud API returns only messages this gateway
          retained under the instance's retention policy; the WhatsApp Web connector reads the recent window the linked device exposes.
        </AlertDescription>
      </Alert>

      {activeChat ? (
        <ChatDialog instanceId={selectedId} chat={activeChat} onClose={() => setActiveChat(null)} />
      ) : null}
    </div>
  );
}
