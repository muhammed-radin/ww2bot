import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Check,
  CheckCheck,
  Download,
  ExternalLink,
  FileText,
  Forward,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Mic,
  Pencil,
  Phone,
  PhoneMissed,
  Quote,
  SmilePlus,
  Video,
} from 'lucide-react';
import { ChatAvatar } from '@/components/chat/avatar.jsx';
import { Button } from '@/components/ui/button.jsx';
import { chatApi } from '@/lib/api.js';
import {
  REACTION_PALETTE,
  downloadBlob,
  formatFileKind,
  formatPhoneNumber,
  isRevoked,
  isSystemMessage,
  messageKind,
  messageTypeLabel,
  pollTally,
  reactionSummary,
} from '@/lib/chat.js';
import { formatBytes, formatClock, formatDateTime, formatSeconds } from '@/lib/format.js';
import { useChatMedia } from '@/hooks/use-chat-media.js';

const URL_PATTERN = /^(https?:\/\/[^\s]+)$/i;

function LinkifiedText({ text }) {
  const parts = String(text ?? '').split(/(https?:\/\/[^\s]+)/gi);
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts.map((part, index) =>
        URL_PATTERN.test(part) ? (
          <a
            key={`${part}-${index}`}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:opacity-80"
          >
            {part}
          </a>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </p>
  );
}

function AckTicks({ ack, fromMe }) {
  if (!fromMe) return null;
  const value = Number(ack ?? 0);
  if (value >= 3) {
    return <CheckCheck className="size-3.5 text-sky-500" aria-label="Read on the linked device" />;
  }
  if (value >= 2) {
    return <CheckCheck className="size-3.5" aria-label="Delivered" />;
  }
  if (value >= 1) {
    return <Check className="size-3.5" aria-label="Sent" />;
  }
  return null;
}

function MediaUnavailable({ error, onRetry, label = 'Media' }) {
  return (
    <div className="flex max-w-sm items-start gap-2 rounded-md border border-dashed p-3 text-xs opacity-90">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label} is not available</p>
        <p className="mt-0.5 break-words">{error || 'The linked device no longer has these bytes.'}</p>
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" className="mt-2 h-7" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MediaNotSupported({ label, detail = null }) {
  return (
    <div className="flex max-w-sm items-start gap-2 rounded-md border border-dashed p-3 text-xs opacity-90">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label} bytes are not available</p>
        <p className="mt-0.5 break-words">
          {detail || 'This connector exposes media metadata only; media downloads are not supported.'}
        </p>
      </div>
    </div>
  );
}

function MediaSkeleton({ label }) {
  return (
    <div className="flex h-40 w-64 items-center justify-center rounded-md bg-muted/40">
      <div className="flex items-center gap-2 text-xs opacity-80">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading {label.toLowerCase()}…
      </div>
    </div>
  );
}

function ContactCards({ contacts }) {
  return (
    <div className="space-y-2">
      {contacts.map((contact, index) => (
        <div key={`${contact.name}-${index}`} className="flex items-center gap-2 rounded-md border p-2">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <Phone className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{contact.name || 'Contact card'}</p>
            {contact.organization ? <p className="truncate text-xs opacity-70">{contact.organization}</p> : null}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {(contact.phones ?? []).map((phone) => (
                <a
                  key={phone}
                  href={`tel:${phone}`}
                  className="text-xs underline underline-offset-2 opacity-90"
                >
                  {formatPhoneNumber(phone)}
                </a>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LocationCard({ location }) {
  // A location URL comes from the linked device; only allow a normal web link.
  const provided = typeof location.url === 'string' ? location.url.trim() : '';
  const url = /^https?:\/\//i.test(provided)
    ? provided
    : `https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=16/${location.latitude}/${location.longitude}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex max-w-sm items-start gap-2 rounded-md border p-2 transition-colors hover:bg-accent/50"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <MapPin className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{location.name || 'Shared location'}</p>
        {location.address ? <p className="truncate text-xs opacity-75">{location.address}</p> : null}
        <p className="mt-0.5 text-[11px] opacity-60">
          {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)}
        </p>
      </div>
      <ExternalLink className="mt-1 size-3.5 shrink-0 opacity-60" aria-hidden="true" />
    </a>
  );
}

function PollCard({ message, capabilities, instanceId, chatId }) {
  const [state, setState] = useState({ status: 'idle', result: null, error: null });
  const tally = useMemo(() => pollTally(message.poll, state.result), [message.poll, state.result]);

  async function loadVotes() {
    setState({ status: 'loading', result: null, error: null });
    try {
      const { data } = await chatApi.pollVotes(instanceId, chatId, message.id);
      setState({ status: 'ready', result: data, error: null });
    } catch (error) {
      setState({ status: 'error', result: null, error: error.message });
    }
  }

  return (
    <div className="min-w-[220px] max-w-sm space-y-2">
      <div className="flex items-start gap-2">
        <BarChart3 className="mt-0.5 size-4 shrink-0 opacity-70" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{message.poll?.question || 'Poll'}</p>
          <p className="text-[11px] opacity-60">
            {message.poll?.allowMultipleAnswers ? 'Multiple answers allowed' : 'One answer'}
            {message.poll?.invalidated ? ' · Poll closed' : ''}
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        {tally.options.map((option) => (
          <div key={`${option.localId}-${option.name}`} className="rounded-md border px-2 py-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{option.name}</span>
              {state.status === 'ready' ? (
                <span className="shrink-0 tabular-nums opacity-70">
                  {option.votes} · {option.percent}%
                </span>
              ) : null}
            </div>
            {state.status === 'ready' ? (
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${option.percent}%` }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {state.status === 'error' ? <p className="text-[11px] text-destructive">{state.error}</p> : null}
      {capabilities?.pollVotes ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          disabled={state.status === 'loading'}
          onClick={loadVotes}
        >
          {state.status === 'loading' ? <Loader2 className="size-3.5 animate-spin" /> : <BarChart3 className="size-3.5" />}
          {state.status === 'ready' ? `Refresh results (${tally.total} votes)` : 'View vote tallies'}
        </Button>
      ) : (
        <p className="text-[11px] opacity-60">Vote tallies are not exposed by this connector.</p>
      )}
      {state.status === 'ready' ? (
        <p className="text-[10px] opacity-60">Tallies come from the linked device; they may lag behind the phone.</p>
      ) : null}
    </div>
  );
}

function CallCard({ message }) {
  const subtype = String(message.subtype ?? '').toLowerCase();
  const missed = subtype.includes('missed') || subtype.includes('not_found');
  const video = subtype.includes('video');
  const Icon = video ? Video : missed ? PhoneMissed : Phone;
  const label = `${missed ? 'Missed ' : ''}${video ? 'video' : 'voice'} call`;
  const duration = Number(message.duration ?? 0);
  return (
    <div className="flex items-center gap-2">
      <div className={`flex size-9 items-center justify-center rounded-full ${missed ? 'bg-destructive/10 text-destructive' : 'bg-muted'}`}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium capitalize">{label}</p>
        <p className="text-[11px] opacity-65">
          {message.fromMe ? 'Outgoing' : 'Incoming'}
          {duration > 0 ? ` · ${formatSeconds(duration)}` : ''}
          {' · Calls cannot be placed from this dashboard'}
        </p>
      </div>
    </div>
  );
}

export function MessageBubble({
  instanceId,
  chatId,
  message,
  showAuthor = false,
  authorName = null,
  capabilities = null,
  onReply,
  onReact,
  onJumpTo,
  onOpenMedia,
}) {
  const kind = messageKind(message);
  const mediaUnsupported = capabilities?.mediaDownload === false;
  // Capabilities are requested alongside messages. Until they arrive, a media
  // bubble is pending, not "unavailable" — avoid a scary flash before the
  // connector tells us whether downloads are supported.
  const mediaPending = capabilities == null;
  const mediaEnabled =
    ['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(kind) &&
    Boolean(message.id) &&
    Boolean(capabilities?.mediaDownload);
  const media = useChatMedia(instanceId, chatId, message.id, { enabled: mediaEnabled });
  const [reactionState, setReactionState] = useState({ status: 'idle', items: [], error: null });
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!capabilities?.messageReactions || !message.hasReaction || !message.id) return undefined;
    setReactionState((previous) => ({ ...previous, status: 'loading' }));
    (async () => {
      try {
        const { data } = await chatApi.reactions(instanceId, chatId, message.id);
        if (!cancelled) setReactionState({ status: 'ready', items: data.reactions ?? [], error: null });
      } catch (error) {
        if (!cancelled) setReactionState({ status: 'error', items: [], error: error.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceId, chatId, message.id, message.hasReaction, capabilities?.messageReactions]);

  if (isSystemMessage(message)) {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-muted/80 px-3 py-1 text-center text-[11px] text-muted-foreground">
          {message.body || messageTypeLabel(message.type)}
        </span>
      </div>
    );
  }

  if (isRevoked(message)) {
    return (
      <div className="my-2 flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/80 px-3 py-1 text-[11px] italic text-muted-foreground">
          <AlertTriangle className="size-3" aria-hidden="true" />
          This message was deleted
        </span>
      </div>
    );
  }

  const outbound = Boolean(message.fromMe);
  const reactions = reactionSummary(reactionState.items);
  const isSticker = kind === 'sticker';
  const bubbleClasses = outbound
    ? 'bg-primary text-primary-foreground'
    : isSticker
      ? 'bg-transparent'
      : 'border bg-card text-card-foreground';

  async function handleReact(emoji) {
    setPickerOpen(false);
    if (!onReact) return;
    try {
      await onReact(message, emoji);
      if (message.id && capabilities?.messageReactions) {
        try {
          const { data } = await chatApi.reactions(instanceId, chatId, message.id);
          setReactionState({ status: 'ready', items: data.reactions ?? [], error: null });
        } catch (readError) {
          // The reaction was accepted; only the follow-up read failed.
          setReactionState({
            status: 'ready',
            items: [{ emoji, senders: [1] }],
            error: `Sent, but the reaction list could not be read: ${readError.message}`,
          });
        }
      } else {
        // The Cloud API can send a reaction but cannot read reactions back.
        // Show the accepted emoji locally rather than implying a read.
        setReactionState({ status: 'ready', items: [{ emoji, senders: [1] }], error: null });
      }
    } catch (error) {
      setReactionState((previous) => ({
        status: 'error',
        items: previous.items ?? [],
        error: error.message,
      }));
    }
  }

  return (
    <div className={`group flex w-full gap-2 ${outbound ? 'justify-end' : 'justify-start'}`} id={`message-${message.id}`}>
      {!outbound && showAuthor ? <ChatAvatar chat={{ chatId: message.author || message.from, displayName: authorName }} size="sm" className="mt-1" /> : null}
      <div className={`relative max-w-[min(82%,42rem)] ${outbound ? 'items-end' : 'items-start'} flex flex-col`}>
        {showAuthor && !outbound && authorName ? (
          <span className="mb-0.5 px-1 text-[11px] font-medium text-muted-foreground">{authorName}</span>
        ) : null}

        <div className={`relative rounded-2xl px-3 py-2 shadow-sm ${bubbleClasses} ${outbound ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
          {message.isForwarded ? (
            <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-60">
              <Forward className="size-3" aria-hidden="true" />
              Forwarded
            </p>
          ) : null}

          {message.quoted ? (
            <button
              type="button"
              onClick={() => message.quoted.id && onJumpTo?.(message.quoted.id)}
              className={`mb-1.5 flex w-full items-start gap-1.5 rounded-md border-l-2 px-2 py-1 text-left ${
                outbound ? 'border-primary-foreground/60 bg-black/10' : 'border-emerald-500 bg-muted/60'
              }`}
            >
              <Quote className="mt-0.5 size-3 shrink-0 opacity-60" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[10px] font-semibold opacity-70">
                  {message.quoted.fromMe ? 'You' : 'Quoted message'}
                </span>
                <span className="block truncate text-xs opacity-80">
                  {message.quoted.body || messageTypeLabel(message.quoted.type)}
                </span>
              </span>
            </button>
          ) : null}

          {kind === 'image' ? (
            media.status === 'ready' ? (
              <button
                type="button"
                className="block overflow-hidden rounded-md"
                onClick={() => onOpenMedia?.({ ...media, filename: message.media?.filename, mimeType: media.mimeType })}
              >
                <img
                  src={media.url}
                  alt={message.caption || message.media?.filename || 'Shared image'}
                  className="max-h-80 w-auto max-w-full object-contain"
                  loading="lazy"
                />
              </button>
            ) : (media.status === 'loading' || mediaPending) ? (
              <MediaSkeleton label="photo" />
            ) : mediaUnsupported ? (
              <MediaNotSupported label="Photo" />
            ) : (
              <MediaUnavailable error={media.error} onRetry={media.reload} label="Photo" />
            )
          ) : null}

          {kind === 'sticker' ? (
            media.status === 'ready' ? (
              <img
                src={media.url}
                alt="Sticker"
                className="max-h-40 w-auto max-w-[10rem] object-contain"
                loading="lazy"
              />
            ) : (media.status === 'loading' || mediaPending) ? (
              <MediaSkeleton label="sticker" />
            ) : mediaUnsupported ? (
              <MediaNotSupported label="Sticker" />
            ) : (
              <MediaUnavailable error={media.error} onRetry={media.reload} label="Sticker" />
            )
          ) : null}

          {kind === 'video' ? (
            media.status === 'ready' ? (
              <div className="space-y-1">
                <video src={media.url} controls preload="metadata" className="max-h-80 w-full max-w-md rounded-md bg-black" />
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] underline underline-offset-2 opacity-80"
                  onClick={() => onOpenMedia?.({ ...media, filename: message.media?.filename, mimeType: media.mimeType })}
                >
                  <ExternalLink className="size-3" aria-hidden="true" />
                  Open larger
                </button>
              </div>
            ) : (media.status === 'loading' || mediaPending) ? (
              <MediaSkeleton label="video" />
            ) : mediaUnsupported ? (
              <MediaNotSupported label="Video" />
            ) : (
              <MediaUnavailable error={media.error} onRetry={media.reload} label="Video" />
            )
          ) : null}

          {kind === 'audio' || kind === 'voice' ? (
            <div className="min-w-[230px] max-w-sm space-y-1">
              <div className="flex items-center gap-2">
                <div className={`flex size-9 shrink-0 items-center justify-center rounded-full ${outbound ? 'bg-black/15' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'}`}>
                  <Mic className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{kind === 'voice' ? 'Voice message' : (message.media?.filename || 'Audio')}</p>
                  <p className="text-[10px] opacity-65">
                    {Number(message.media?.duration ?? message.duration) > 0
                      ? formatSeconds(message.media?.duration ?? message.duration)
                      : formatFileKind(message.media?.mimetype)}
                    {message.media?.size ? ` · ${formatBytes(message.media.size)}` : ''}
                  </p>
                </div>
              </div>
              {media.status === 'ready' ? (
                <audio src={media.url} controls preload="metadata" className="h-9 w-full" />
              ) : (media.status === 'loading' || mediaPending) ? (
                <div className="flex h-9 items-center gap-2 text-[11px] opacity-70">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  Loading audio…
                </div>
              ) : mediaUnsupported ? (
                <MediaNotSupported label="Audio" />
              ) : (
                <MediaUnavailable error={media.error} onRetry={media.reload} label="Audio" />
              )}
            </div>
          ) : null}

          {kind === 'document' ? (
            media.status === 'ready' ? (
              <div className="flex min-w-[230px] max-w-sm items-center gap-2 rounded-md border p-2">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <FileText className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{message.media?.filename || 'Document'}</p>
                  <p className="text-[10px] opacity-65">
                    {formatFileKind(message.media?.mimetype)}
                    {message.media?.size ? ` · ${formatBytes(message.media.size)}` : media.blob?.size ? ` · ${formatBytes(media.blob.size)}` : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0"
                  aria-label="Download document"
                  onClick={() => downloadBlob(media.blob, message.media?.filename || 'document')}
                >
                  <Download className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ) : (media.status === 'loading' || mediaPending) ? (
              <div className="flex min-w-[230px] items-center gap-2 rounded-md border p-2 text-xs opacity-70">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading document…
              </div>
            ) : mediaUnsupported ? (
              <MediaNotSupported
                label="Document"
                detail={
                  message.media?.filename
                    ? `${message.media.filename} is recorded, but this connector cannot download retained media bytes.`
                    : undefined
                }
              />
            ) : (
              <MediaUnavailable error={media.error} onRetry={media.reload} label="Document" />
            )
          ) : null}

          {kind === 'location' && message.location ? <LocationCard location={message.location} /> : null}
          {kind === 'contact' && message.contacts?.length ? <ContactCards contacts={message.contacts} /> : null}
          {kind === 'poll' && message.poll ? (
            <PollCard message={message} capabilities={capabilities} instanceId={instanceId} chatId={chatId} />
          ) : null}
          {kind === 'call' ? <CallCard message={message} /> : null}

          {message.caption && kind !== 'text' ? (
            <div className="mt-1.5">
              <LinkifiedText text={message.caption} />
            </div>
          ) : null}

          {kind === 'text' || kind === 'unknown' || kind === 'reaction' ? (
            message.body ? (
              <LinkifiedText text={message.body} />
            ) : kind === 'reaction' ? (
              <p className="text-sm italic opacity-70">Reaction</p>
            ) : (
              <p className="text-sm italic opacity-70">{messageTypeLabel(message.type)}</p>
            )
          ) : null}

          <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${outbound ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
            {message.isEdited ? (
              <span className="inline-flex items-center gap-0.5" title="Edited on the linked device">
                <Pencil className="size-2.5" aria-hidden="true" />
                Edited
              </span>
            ) : null}
            <span title={formatDateTime(message.timestamp)}>{formatClock(message.timestamp)}</span>
            <AckTicks ack={message.ack} fromMe={outbound} />
          </div>
        </div>

        {reactions.length > 0 ? (
          <div className={`-mt-1 flex flex-wrap gap-1 px-1 ${outbound ? 'justify-end' : 'justify-start'}`}>
            {reactions.map((reaction) => (
              <span
                key={reaction.emoji}
                className="inline-flex items-center gap-0.5 rounded-full border bg-background px-1.5 py-0.5 text-[11px] shadow-sm"
                title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
              >
                {reaction.emoji}
                {reaction.count > 1 ? <span className="text-[9px] text-muted-foreground">{reaction.count}</span> : null}
              </span>
            ))}
          </div>
        ) : null}
        {reactionState.status === 'error' ? (
          <p className="px-1 text-[10px] text-destructive">Reactions could not be read: {reactionState.error}</p>
        ) : null}

        <div className={`absolute -top-8 z-10 flex items-center gap-0.5 rounded-full border bg-background p-0.5 shadow-md transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 ${outbound ? 'right-0' : 'left-0'}`}>
          {onReply ? (
            <Button type="button" size="icon" variant="ghost" className="size-7 rounded-full" onClick={() => onReply(message)} aria-label="Reply" title="Reply">
              <Quote className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {onReact && capabilities?.sendReaction ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 rounded-full"
                onClick={() => setPickerOpen((value) => !value)}
                aria-label="React"
                title="React"
              >
                <SmilePlus className="size-3.5" aria-hidden="true" />
              </Button>
              {pickerOpen ? (
                <div className={`absolute top-8 flex gap-0.5 rounded-full border bg-popover p-1 shadow-lg ${outbound ? 'right-0' : 'left-0'}`}>
                  {REACTION_PALETTE.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="rounded-full px-1.5 py-0.5 text-base hover:bg-accent"
                      onClick={() => handleReact(emoji)}
                      aria-label={`React with ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {message.hasMedia && media.status === 'ready' ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              onClick={() => onOpenMedia?.({ ...media, filename: message.media?.filename, mimeType: media.mimeType })}
              aria-label="Open media"
              title="Open media"
            >
              <ImageIcon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {message.hasMedia && media.status === 'ready' && media.blob ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              onClick={() => downloadBlob(media.blob, message.media?.filename || 'media')}
              aria-label="Download media"
              title="Download media"
            >
              <Download className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
