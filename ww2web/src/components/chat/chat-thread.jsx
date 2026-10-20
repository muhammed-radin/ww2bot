import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  Info,
  Loader2,
  MessageCircle,
  MoreVertical,
  RefreshCw,
} from 'lucide-react';
import { ChatAvatar } from '@/components/chat/avatar.jsx';
import { ChatComposer } from '@/components/chat/chat-composer.jsx';
import { MessageBubble } from '@/components/chat/message-bubble.jsx';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Button } from '@/components/ui/button.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.jsx';
import { Skeleton } from '@/components/ui/skeleton.jsx';
import { chatDisplayName, chatKind, chatPhone, isSystemMessage } from '@/lib/chat.js';
import { formatDay } from '@/lib/format.js';

function MessageSkeleton() {
  return (
    <div className="space-y-4 p-4">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
          <Skeleton className={`h-14 rounded-2xl ${index % 2 === 0 ? 'w-2/5' : 'w-1/3'}`} />
        </div>
      ))}
    </div>
  );
}

function authorLabel(message) {
  const id = String(message.author || message.from || '');
  const [user, server] = id.split('@');
  // LID participants are opaque linked identities, not phone numbers.
  if (server && server !== 'c.us') return 'Group member';
  if (user && /^\d{5,}$/.test(user)) return `+${user}`;
  return user || 'Group member';
}

/**
 * Conversation pane. Messages are rendered in timestamp order even when a
 * connector returns newest-first; no message is reordered by guesswork beyond
 * that stable timestamp sort.
 */
export function ChatThread({
  instance,
  chat,
  capabilities = null,
  messages = [],
  loading = false,
  error = null,
  refreshing = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  onRefresh,
  onBack,
  onOpenConnect,
  onOpenDetails,
  onSendText,
  onSendMedia,
  onSendPoll,
  onSendLocation,
  onSendContact,
  onReact,
  onOpenMedia,
}) {
  const [replyTo, setReplyTo] = useState(null);
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const nearBottomRef = useRef(true);
  const previousLengthRef = useRef(0);

  const ordered = useMemo(() => {
    return [...messages].sort((left, right) => {
      const leftAt = left?.timestamp ? new Date(left.timestamp).getTime() : 0;
      const rightAt = right?.timestamp ? new Date(right.timestamp).getTime() : 0;
      return leftAt - rightAt;
    });
  }, [messages]);

  useEffect(() => {
    setReplyTo(null);
    previousLengthRef.current = 0;
    nearBottomRef.current = true;
  }, [chat?.chatId]);

  useEffect(() => {
    if (!ordered.length) return;
    const grew = ordered.length > previousLengthRef.current;
    previousLengthRef.current = ordered.length;
    if (!grew) return;
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      setShowJump(false);
    } else if ((scrollRef.current?.scrollTop ?? 0) > 200) {
      // A growth caused by "load older" happens at the top; don't label it as
      // a new incoming message.
      setShowJump(true);
    }
  }, [ordered.length]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    nearBottomRef.current = distance < 140;
    if (nearBottomRef.current) setShowJump(false);
  }

  function jumpToLatest() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    setShowJump(false);
  }

  function jumpToMessage(messageId) {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('ring-2', 'ring-emerald-500/70', 'rounded-xl');
    setTimeout(() => element.classList.remove('ring-2', 'ring-emerald-500/70', 'rounded-xl'), 1600);
  }

  const notConnected = error?.code === 'INSTANCE_NOT_CONNECTED';

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
        <Button type="button" size="icon" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to chats">
          <ArrowLeft aria-hidden="true" />
        </Button>
        <ChatAvatar chat={chat} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{chatDisplayName(chat)}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {chatKind(chat)}
            {chatPhone(chat) ? ` · ${chatPhone(chat)}` : ''}
            {chat?.chatId ? ` · ${chat.chatId}` : ''}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => onRefresh?.()}
          disabled={refreshing}
          aria-label="Refresh messages"
          title="Refresh messages"
        >
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => onOpenDetails?.()}
          aria-label="Conversation details"
          title="Conversation details"
        >
          <Info aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" variant="ghost" aria-label="More chat actions">
              <MoreVertical aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRefresh?.()}>
              <RefreshCw aria-hidden="true" />
              Refresh recent window
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenDetails?.()}>
              <Info aria-hidden="true" />
              Show limitations
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {notConnected ? (
        <div className="p-3">
          <Alert variant="warning">
            <MessageCircle />
            <AlertTitle>The instance is not connected</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>{error?.message || 'Complete QR or pairing-code authentication first.'}</span>
              {onOpenConnect ? (
                <Button type="button" size="sm" variant="outline" onClick={onOpenConnect}>
                  Open connection
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 py-3 sm:px-4"
        style={{
          backgroundImage:
            'radial-gradient(hsl(var(--muted-foreground) / 0.10) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      >
        {hasMore ? (
          <div className="mb-3 flex justify-center">
            <Button type="button" size="sm" variant="outline" onClick={() => onLoadOlder?.()} disabled={loadingOlder}>
              {loadingOlder ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Load older messages
            </Button>
          </div>
        ) : null}

        {loading && ordered.length === 0 ? (
          <MessageSkeleton />
        ) : error && !notConnected ? (
          <div className="mx-auto max-w-md p-4 text-center">
            <p className="text-sm font-medium">Messages could not be loaded</p>
            <p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => onRefresh?.()}>
              Try again
            </Button>
          </div>
        ) : ordered.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="rounded-full bg-muted p-3">
              <MessageCircle className="size-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium">No messages in this window</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {capabilities?.connector === 'web'
                ? 'WhatsApp Web exposes only the recent messages the linked device has loaded. Open the conversation on the phone, then refresh.'
                : 'This gateway has no retained messages for this conversation. Enable retention and let messages be recorded, or check that the chat id is correct.'}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-1.5">
            {ordered.map((message, index) => {
              const previous = ordered[index - 1];
              const day = formatDay(message.timestamp);
              const previousDay = previous ? formatDay(previous.timestamp) : null;
              const system = isSystemMessage(message);
              return (
                <div key={message.id || message.storedId || `${message.timestamp}-${index}`}>
                  {day && day !== previousDay ? (
                    <div className="my-3 flex justify-center">
                      <span className="rounded-full border bg-background/90 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm">
                        {day}
                      </span>
                    </div>
                  ) : null}
                  <MessageBubble
                    instanceId={instance?.id}
                    chatId={chat?.chatId}
                    message={message}
                    showAuthor={Boolean(chat?.isGroup) && !message.fromMe && !system}
                    authorName={authorLabel(message)}
                    capabilities={capabilities}
                    onReply={capabilities?.outboundMessaging ? setReplyTo : undefined}
                    onReact={onReact}
                    onJumpTo={jumpToMessage}
                    onOpenMedia={onOpenMedia}
                  />
                </div>
              );
            })}
            <div ref={bottomRef} className="h-1" />
          </div>
        )}
      </div>

      {showJump ? (
        <div className="pointer-events-none relative">
          <Button
            type="button"
            size="sm"
            className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-lg"
            onClick={jumpToLatest}
          >
            <ArrowDown aria-hidden="true" />
            New messages
          </Button>
        </div>
      ) : null}

      <ChatComposer
        instanceId={instance?.id}
        chatId={chat?.chatId}
        connector={instance?.connector}
        capabilities={capabilities}
        disabled={!chat?.chatId || Boolean(notConnected)}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSendText={onSendText}
        onSendMedia={onSendMedia}
        onSendPoll={onSendPoll}
        onSendLocation={onSendLocation}
        onSendContact={onSendContact}
        onOpenConnect={onOpenConnect}
      />
    </section>
  );
}
