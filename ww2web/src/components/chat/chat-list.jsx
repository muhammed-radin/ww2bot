import { useMemo, useState } from 'react';
import { AlertTriangle, Inbox, MessageCircle, Pin, RefreshCw, Search, Users, VolumeX } from 'lucide-react';
import { ChatAvatar } from '@/components/chat/avatar.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Skeleton } from '@/components/ui/skeleton.jsx';
import { chatDisplayName, chatKind, previewWithAuthor, truncate } from '@/lib/chat.js';
import { formatClock, formatDay, instanceStatus } from '@/lib/format.js';

function ChatRow({ chat, selected, onSelect }) {
  const last = chat.lastMessage;
  const at = last?.timestamp ?? chat.lastMessageAt;
  const unread = Number(chat.unreadCount ?? 0);
  return (
    <button
      type="button"
      onClick={() => onSelect(chat)}
      className={`flex w-full items-start gap-3 border-b px-3 py-3 text-left transition-colors hover:bg-accent/70 ${
        selected ? 'bg-accent' : 'bg-transparent'
      }`}
      aria-current={selected ? 'true' : undefined}
    >
      <ChatAvatar chat={chat} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{chatDisplayName(chat)}</span>
          {at ? <span className="shrink-0 text-[11px] text-muted-foreground">{formatClock(at)}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {chat.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" /> : null}
          {chat.isMuted ? <VolumeX className="size-3 shrink-0 text-muted-foreground" aria-label="Muted" /> : null}
          {chat.isGroup ? <Users className="size-3 shrink-0 text-muted-foreground" aria-label="Group" /> : null}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {last
              ? previewWithAuthor(last)
              : Number(chat.messageCount) > 0
                ? `${chat.messageCount} retained message${Number(chat.messageCount) === 1 ? '' : 's'}`
                : 'No messages in this window'}
          </span>
          {unread > 0 ? (
            <Badge variant="success" className="h-5 min-w-5 justify-center rounded-full px-1.5 text-[10px]">
              {unread > 99 ? '99+' : unread}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>{chatKind(chat)}</span>
          {at ? <span className="normal-case tracking-normal">{formatDay(at)}</span> : null}
        </div>
      </div>
    </button>
  );
}

function ChatListSkeleton() {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} className="flex items-start gap-3 px-2 py-3">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Conversation sidebar: instance picker, search and the linked device's recent
 * chat window. Chats are sorted by the linked device's own timestamp; the
 * gateway does not re-rank them by guessed activity.
 */
export function ChatList({
  instances = [],
  instanceId,
  onInstanceChange,
  chats = [],
  loading = false,
  error = null,
  selectedChatId,
  onSelect,
  onRefresh,
  refreshing = false,
  capabilities = null,
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter((chat) => {
      const haystack = [
        chatDisplayName(chat),
        chat.chatId,
        chat.lastMessage ? previewWithAuthor(chat.lastMessage) : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [chats, query]);

  const selectedInstance = instances.find((instance) => instance.id === instanceId) ?? null;
  const status = instanceStatus(selectedInstance?.status);

  return (
    <aside className="flex h-full min-h-0 w-full shrink-0 flex-col border-r bg-sidebar/60 md:w-[360px]">
      <div className="space-y-3 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">Chats</h1>
            <p className="truncate text-xs text-muted-foreground">
              {capabilities?.connector === 'web'
                ? 'Linked-device recent window'
                : 'Retained messages only'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onRefresh?.()}
            disabled={refreshing}
            aria-label="Refresh chats"
            title="Refresh chats"
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          </Button>
        </div>

        <Select value={instanceId ?? undefined} onValueChange={onInstanceChange}>
          <SelectTrigger className="h-9" aria-label="Instance">
            <SelectValue placeholder="Choose an instance" />
          </SelectTrigger>
          <SelectContent>
            {instances.map((instance) => (
              <SelectItem key={instance.id} value={instance.id}>
                {instance.displayName || instance.connector} · {instanceStatus(instance.status).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedInstance ? (
          <div className="flex items-center gap-2">
            <Badge variant={status.tone === 'destructive' ? 'destructive' : status.tone === 'success' ? 'success' : 'muted'}>
              {status.label}
            </Badge>
            <span className="truncate text-[11px] text-muted-foreground">
              {selectedInstance.connector === 'web' ? 'WhatsApp Web' : 'Cloud API'}
            </span>
          </div>
        ) : null}

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, number or chat id"
            className="h-9 pl-8"
            aria-label="Search chats"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <ChatListSkeleton />
        ) : error ? (
          <ErrorState
            error={error}
            title="Chats could not be loaded"
            className="m-3"
            onRetry={() => onRefresh?.()}
          />
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="rounded-full bg-muted p-3">
              {query ? <Search className="size-6 text-muted-foreground" /> : <Inbox className="size-6 text-muted-foreground" />}
            </div>
            <div>
              <p className="text-sm font-medium">{query ? 'No matching chats' : 'No chats in this window'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {query
                  ? 'Try a different name, number or chat id.'
                  : capabilities?.connector === 'web'
                    ? 'Open WhatsApp on the linked phone to load recent conversations, then refresh.'
                    : 'No retained conversations yet. Enable retention and let messages be recorded through this gateway.'}
              </p>
            </div>
            {!query ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onRefresh?.()}>
                <MessageCircle className="size-4" aria-hidden="true" />
                Refresh
              </Button>
            ) : null}
          </div>
        ) : (
          filtered.map((chat) => (
            <ChatRow
              key={chat.chatId}
              chat={chat}
              selected={chat.chatId === selectedChatId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        {capabilities?.limitations?.[0] ?? (
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="size-3" aria-hidden="true" />
            {truncate('Reads are limited to what the selected connector exposes.', 70)}
          </span>
        )}
      </div>
    </aside>
  );
}
