import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Loader2, MessageCircle, Server } from 'lucide-react';
import { toast } from 'sonner';
import { ChatDetailsDialog } from '@/components/chat/chat-details-dialog.jsx';
import { ChatList } from '@/components/chat/chat-list.jsx';
import { ChatThread } from '@/components/chat/chat-thread.jsx';
import { MediaDialog } from '@/components/chat/media-dialog.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx';
import { Button } from '@/components/ui/button.jsx';
import { useApi } from '@/hooks/use-api.js';
import { useConnectionEvents } from '@/hooks/use-connection-events.js';
import { chatApi, instancesApi } from '@/lib/api.js';
import { chatDisplayName, messagePreview } from '@/lib/chat.js';

const EMPTY_MESSAGES = Object.freeze({
  chatId: null,
  items: [],
  older: [],
  pagination: null,
  olderCursor: undefined,
  loading: false,
  loaded: false,
  error: null,
  olderLoading: false,
});

/**
 * Advanced, full-page conversation view.
 *
 * This is deliberately a page, not another tab on the Data screen: it has its
 * own layout, live stream, composer and media viewer. Reads are capability-gated
 * and every send is an explicit action; nothing is optimistically marked as
 * delivered.
 */
export default function ChatPage() {
  const { chatId: routeChatId } = useParams();
  const navigate = useNavigate();
  const [instanceId, setInstanceId] = useState(null);
  const [selectedChatId, setSelectedChatId] = useState(routeChatId ?? null);
  const [mobileView, setMobileView] = useState(routeChatId ? 'thread' : 'list');
  // Read receipts are only honest when the thread is actually on screen. On a
  // narrow viewport the list and thread are separate panes at the same URL.
  const threadVisible =
    mobileView === 'thread' ||
    (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  const [messagesState, setMessagesState] = useState(EMPTY_MESSAGES);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mediaViewer, setMediaViewer] = useState(null);
  const messagesRequestRef = useRef(0);
  const lastEventKeyRef = useRef(null);

  const instancesQuery = useApi(() => instancesApi.list({ limit: 100 }), [], { pollMs: 20000 });
  const instanceList = useMemo(() => instancesQuery.data?.data?.items ?? [], [instancesQuery.data]);

  useEffect(() => {
    if (instanceId || instanceList.length === 0) return;
    const preferred = instanceList.find((instance) => instance.status === 'ready') ?? instanceList[0];
    setInstanceId(preferred.id);
  }, [instanceList, instanceId]);

  const instance = useMemo(
    () => instanceList.find((entry) => entry.id === instanceId) ?? null,
    [instanceList, instanceId],
  );

  const capsQuery = useApi(async () => {
    if (!instanceId) return null;
    const result = await instancesApi.capabilities(instanceId);
    return { instanceId, ...result };
  }, [instanceId]);

  const capabilities = capsQuery.data?.instanceId === instanceId ? capsQuery.data.data.capabilities : null;

  const chatsQuery = useApi(async () => {
    if (!instanceId) return null;
    const result = await instancesApi.chats(instanceId, { limit: 100 });
    return { instanceId, ...result };
  }, [instanceId], { pollMs: 30000 });

  const chatPayload = chatsQuery.data?.instanceId === instanceId ? chatsQuery.data : null;
  const chatItems = useMemo(() => chatPayload?.data?.items ?? [], [chatPayload]);
  const reloadChats = chatsQuery.reload;

  useEffect(() => {
    setDetailsOpen(false);
    setMediaViewer(null);
    if (routeChatId) {
      setSelectedChatId(routeChatId);
      setMobileView('thread');
    } else {
      // Browser back from /chats/:chatId must return a narrow viewport to the
      // list. On desktop both panes stay visible, so the selected chat remains.
      setMobileView('list');
    }
  }, [routeChatId]);

  useEffect(() => {
    if (selectedChatId || chatItems.length === 0) return;
    const preferred = routeChatId && chatItems.some((chat) => chat.chatId === routeChatId) ? routeChatId : chatItems[0].chatId;
    setSelectedChatId(preferred);
  }, [chatItems, selectedChatId, routeChatId]);

  const selectedChat = useMemo(() => {
    const found = chatItems.find((chat) => chat.chatId === selectedChatId);
    if (found) return found;
    if (!selectedChatId) return null;
    return {
      chatId: selectedChatId,
      displayName: null,
      isGroup: selectedChatId.endsWith('@g.us'),
      unreadCount: 0,
      lastMessage: null,
      lastMessageAt: null,
    };
  }, [chatItems, selectedChatId]);

  const loadMessages = useCallback(
    async ({ silent = false } = {}) => {
      if (!instanceId || !selectedChatId) return;
      const requestId = messagesRequestRef.current + 1;
      messagesRequestRef.current = requestId;
      setMessagesState((previous) => ({
        ...previous,
        chatId: selectedChatId,
        loading: silent ? previous.loading : previous.chatId !== selectedChatId || !previous.loaded,
        error: null,
      }));
      try {
        const result = await instancesApi.messages(instanceId, selectedChatId, { limit: 100 });
        if (messagesRequestRef.current !== requestId) return;
        setMessagesState({
          chatId: selectedChatId,
          items: result.data.items ?? [],
          older: [],
          pagination: result.pagination ?? null,
          olderCursor: undefined,
          loading: false,
          loaded: true,
          error: null,
          olderLoading: false,
        });
      } catch (error) {
        if (messagesRequestRef.current !== requestId) return;
        setMessagesState((previous) => ({
          ...previous,
          chatId: selectedChatId,
          loading: false,
          loaded: true,
          error,
        }));
      }
    },
    [instanceId, selectedChatId],
  );

  useEffect(() => {
    setMessagesState(EMPTY_MESSAGES);
    loadMessages();
  }, [loadMessages]);

  const messages = useMemo(() => {
    if (messagesState.chatId !== selectedChatId) return [];
    const seen = new Set();
    const combined = [];
    for (const message of [...messagesState.older, ...messagesState.items]) {
      const key = message.storedId ?? message.id ?? `${message.timestamp}-${message.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(message);
    }
    return combined;
  }, [messagesState.older, messagesState.items, messagesState.chatId, selectedChatId]);

  const visibleMessagesError = messagesState.chatId === selectedChatId ? messagesState.error : null;
  const messagesLoading = messagesState.chatId !== selectedChatId || messagesState.loading;

  const olderCursor =
    messagesState.olderCursor === undefined ? messagesState.pagination?.nextCursor : messagesState.olderCursor;
  const hasMoreMessages = Boolean(olderCursor) && messagesState.chatId === selectedChatId;

  const loadOlder = useCallback(async () => {
    if (!instanceId || !selectedChatId || !olderCursor || messagesState.olderLoading) return;
    setMessagesState((previous) => ({ ...previous, olderLoading: true }));
    try {
      const result = await instancesApi.messages(instanceId, selectedChatId, { limit: 100, cursor: olderCursor });
      setMessagesState((previous) => {
        const seen = new Set(
          [...previous.older, ...previous.items].map(
            (message) => message.storedId ?? message.id ?? `${message.timestamp}-${message.body}`,
          ),
        );
        const older = (result.data.items ?? []).filter((message) => {
          const key = message.storedId ?? message.id ?? `${message.timestamp}-${message.body}`;
          return !seen.has(key);
        });
        return {
          ...previous,
          older: [...older, ...previous.older],
          olderCursor: result.pagination?.nextCursor ?? null,
          olderLoading: false,
        };
      });
    } catch (error) {
      setMessagesState((previous) => ({ ...previous, olderLoading: false }));
      toast.error(error?.message ?? 'Older messages could not be loaded.');
    }
  }, [instanceId, selectedChatId, olderCursor, messagesState.olderLoading]);

  /* ------------------------------ live stream ----------------------------- */

  const { lastEvent } = useConnectionEvents(instanceId, { enabled: Boolean(instanceId) });

  useEffect(() => {
    if (!lastEvent || lastEvent.key === lastEventKeyRef.current) return;
    lastEventKeyRef.current = lastEvent.key;
    if (lastEvent.type !== 'message.received' && lastEvent.type !== 'message.sent') return;
    const data = lastEvent.raw ?? {};
    if (!data.chatId) return;
    reloadChats({ silent: true });
    if (data.chatId === selectedChatId) {
      loadMessages({ silent: true });
      if (
        lastEvent.type === 'message.received' &&
        threadVisible &&
        capabilities?.markChatSeen &&
        document.visibilityState === 'visible'
      ) {
        chatApi
          .seen(instanceId, data.chatId)
          .then(() => reloadChats({ silent: true }))
          .catch(() => {
            /* Read receipts are best-effort. */
          });
      }
    } else if (lastEvent.type === 'message.received' && document.visibilityState !== 'visible') {
      toast.info(`New message in ${chatDisplayName({ chatId: data.chatId })}`, {
        description: messagePreview(data),
      });
    }
  }, [lastEvent, selectedChatId, instanceId, capabilities?.markChatSeen, reloadChats, loadMessages, threadVisible]);

  /* ------------------------------ mark as read ---------------------------- */

  useEffect(() => {
    if (!instanceId || !selectedChatId || !capabilities?.markChatSeen) return undefined;
    // Do not send a read receipt for a conversation the user cannot see yet,
    // and do not do it before the thread actually loaded successfully.
    if (!threadVisible) return undefined;
    if (messagesState.chatId !== selectedChatId || !messagesState.loaded) return undefined;
    let cancelled = false;
    chatApi
      .seen(instanceId, selectedChatId)
      .then(() => {
        if (!cancelled) reloadChats({ silent: true });
      })
      .catch(() => {
        /* Read receipts are best-effort; a failure must not break the thread. */
      });
    return () => {
      cancelled = true;
    };
  }, [
    instanceId,
    selectedChatId,
    capabilities?.markChatSeen,
    messagesState.chatId,
    messagesState.loaded,
    reloadChats,
    threadVisible,
  ]);

  /* -------------------------------- actions ------------------------------- */

  function selectInstance(nextId) {
    setInstanceId(nextId);
    setSelectedChatId(null);
    setMessagesState(EMPTY_MESSAGES);
    setMobileView('list');
    setDetailsOpen(false);
    setMediaViewer(null);
    navigate('/chats', { replace: true });
  }

  function selectChat(chat) {
    setSelectedChatId(chat.chatId);
    setMobileView('thread');
    navigate(`/chats/${encodeURIComponent(chat.chatId)}`);
  }

  async function refreshAll() {
    await Promise.allSettled([chatsQuery.reload({ silent: true }), loadMessages({ silent: true })]);
  }

  async function sendText(text, replyToMessageId, idempotencyKey) {
    await chatApi.sendText(instanceId, selectedChatId, {
      text,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    await Promise.allSettled([loadMessages({ silent: true }), chatsQuery.reload({ silent: true })]);
  }

  async function sendMedia({ file, caption, voice, asDocument, replyToMessageId, idempotencyKey }) {
    const result = await chatApi.sendMedia(instanceId, selectedChatId, {
      file,
      caption,
      voice,
      asDocument,
      replyToMessageId,
      idempotencyKey,
    });
    if (result?.data?.warning) toast.warning(result.data.warning);
    await Promise.allSettled([loadMessages({ silent: true }), chatsQuery.reload({ silent: true })]);
  }

  async function sendPoll(payload, replyToMessageId) {
    await chatApi.sendPoll(instanceId, selectedChatId, {
      ...payload,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    await Promise.allSettled([loadMessages({ silent: true }), chatsQuery.reload({ silent: true })]);
  }

  async function sendLocation(payload, replyToMessageId) {
    await chatApi.sendLocation(instanceId, selectedChatId, {
      ...payload,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    await Promise.allSettled([loadMessages({ silent: true }), chatsQuery.reload({ silent: true })]);
  }

  async function sendContact(payload, replyToMessageId) {
    await chatApi.sendContact(instanceId, selectedChatId, {
      ...payload,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    await Promise.allSettled([loadMessages({ silent: true }), chatsQuery.reload({ silent: true })]);
  }

  async function react(message, emoji) {
    if (!message?.id) throw new Error('This message has no provider id, so it cannot be reacted to.');
    await chatApi.react(instanceId, selectedChatId, message.id, emoji);
  }

  /* -------------------------------- layout -------------------------------- */

  if (instancesQuery.loading && instanceList.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading instances…
      </div>
    );
  }

  if (instancesQuery.error && instanceList.length === 0) {
    return (
      <div className="p-4">
        <ErrorState error={instancesQuery.error} title="Instances could not be loaded" onRetry={() => instancesQuery.reload()} />
      </div>
    );
  }

  if (instanceList.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={Server}
          title="No instances yet"
          description="Create a WhatsApp Web instance, link it, then return here to open a conversation."
          action={
            <Button asChild>
              <Link to="/instances">Create an instance</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      <div className={`${mobileView === 'thread' ? 'hidden md:flex' : 'flex'} h-full w-full md:w-[360px] md:shrink-0`}>
        <ChatList
          instances={instanceList}
          instanceId={instanceId}
          onInstanceChange={selectInstance}
          chats={chatItems}
          loading={Boolean(instanceId) && chatsQuery.loading && chatItems.length === 0}
          error={chatsQuery.error}
          selectedChatId={selectedChatId}
          onSelect={selectChat}
          onRefresh={() => chatsQuery.reload({ silent: true })}
          refreshing={chatsQuery.refetching}
          capabilities={capabilities}
        />
      </div>

      <div className={`${mobileView === 'list' ? 'hidden md:flex' : 'flex'} h-full min-w-0 flex-1 flex-col`}>
        {!instanceId ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            Loading conversation…
          </div>
        ) : !selectedChatId ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="rounded-full bg-muted p-4">
              <MessageCircle className="size-7 text-muted-foreground" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium">Choose a conversation</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                The left column lists the chats the selected connector can serve. Live messages arrive over the
                authenticated event stream.
              </p>
            </div>
          </div>
        ) : (
          <>
            {chatsQuery.error?.code === 'CAPABILITY_NOT_SUPPORTED' ? (
              <div className="p-3">
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertTitle>Chats are not available on this connector</AlertTitle>
                  <AlertDescription>{chatsQuery.error.message}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            <ChatThread
              instance={instance}
              chat={selectedChat}
              capabilities={capabilities}
              messages={messages}
              loading={messagesLoading}
              error={visibleMessagesError}
              refreshing={messagesLoading}
              hasMore={hasMoreMessages}
              loadingOlder={messagesState.olderLoading}
              onLoadOlder={loadOlder}
              onRefresh={() => refreshAll()}
              onBack={() => {
                setMobileView('list');
                navigate('/chats', { replace: true });
              }}
              onOpenConnect={() => navigate('/connection')}
              onOpenDetails={() => setDetailsOpen(true)}
              onSendText={sendText}
              onSendMedia={sendMedia}
              onSendPoll={sendPoll}
              onSendLocation={sendLocation}
              onSendContact={sendContact}
              onReact={react}
              onOpenMedia={(media) => setMediaViewer(media)}
            />
          </>
        )}
      </div>

      <ChatDetailsDialog
        chat={selectedChat}
        capabilities={capabilities}
        instance={instance}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
      <MediaDialog media={mediaViewer} open={Boolean(mediaViewer)} onOpenChange={(open) => !open && setMediaViewer(null)} />
    </div>
  );
}
