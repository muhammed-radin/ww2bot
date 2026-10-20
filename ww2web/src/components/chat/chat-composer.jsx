import { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  Contact,
  FileText,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Mic,
  Paperclip,
  Send,
  Smile,
  Square,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { ContactDialog } from '@/components/chat/contact-dialog.jsx';
import { LocationDialog } from '@/components/chat/location-dialog.jsx';
import { PollDialog } from '@/components/chat/poll-dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Textarea } from '@/components/ui/textarea.jsx';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder.js';
import { formatBytes, formatSeconds } from '@/lib/format.js';
import { formatFileKind } from '@/lib/chat.js';
import { prepareOutboundImage } from '@/lib/image.js';

const EMOJIS = ['😀', '😂', '😊', '😍', '🤔', '😮', '😢', '🙏', '👍', '👎', '❤️', '🔥', '🎉', '✅', '❌', '👏', '💯', '🚀', '☕', '🌙'];

function inferKind(file) {
  const type = String(file?.type ?? '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

function voiceFileName(mimeType) {
  if (String(mimeType).includes('ogg')) return 'voice-note.ogg';
  if (String(mimeType).includes('mp4')) return 'voice-note.m4a';
  return 'voice-note.webm';
}

function newSendKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Conversation composer: text, photos/video/documents/audio, browser voice
 * notes, polls, static locations and contact cards.
 */
export function ChatComposer({
  instanceId,
  chatId,
  connector = 'web',
  capabilities = null,
  disabled = false,
  replyTo = null,
  onCancelReply,
  onSendText,
  onSendMedia,
  onSendPoll,
  onSendLocation,
  onSendContact,
  onOpenConnect,
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [pending, setPending] = useState(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const acceptRef = useRef('*/*');
  const pendingUrlRef = useRef(null);
  const prepareTokenRef = useRef(0);
  const busyRef = useRef(null);
  const recorder = useVoiceRecorder();

  const canSend = capabilities?.outboundMessaging && !disabled;
  const canMedia = canSend && Boolean(capabilities?.sendMedia);
  const canPoll = canSend && Boolean(capabilities?.sendPoll);
  const canLocation = canSend && Boolean(capabilities?.sendLocation);
  const canContact = canSend && Boolean(capabilities?.sendContact);
  const maxMediaBytes = Number(capabilities?.maxMediaUploadBytes ?? 0) || null;

  useEffect(() => {
    setDraft('');
    clearPending();
    setEmojiOpen(false);
    // clearPending also revokes the previous preview URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => () => {
    if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [draft]);

  function clearPending() {
    prepareTokenRef.current += 1;
    setPreparing(false);
    if (pendingUrlRef.current) {
      URL.revokeObjectURL(pendingUrlRef.current);
      pendingUrlRef.current = null;
    }
    setPending(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function pickFile(accept) {
    acceptRef.current = accept;
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.click();
  }

  async function onFilePicked(event) {
    const file = event.target.files?.[0];
    // Clear the input immediately so picking the same file again still fires
    // a change event; the File object remains readable after this.
    event.target.value = '';
    if (!file) return;

    const token = ++prepareTokenRef.current;
    const kind = inferKind(file);
    setEmojiOpen(false);
    setPreparing(false);
    if (pendingUrlRef.current) {
      URL.revokeObjectURL(pendingUrlRef.current);
      pendingUrlRef.current = null;
    }
    setPending(null);

    if (kind === 'image') {
      setPreparing(true);
      const prepared = await prepareOutboundImage(file, { maxBytes: maxMediaBytes });
      if (token !== prepareTokenRef.current) return;
      setPreparing(false);
      if (maxMediaBytes && prepared.file.size > maxMediaBytes) {
        toast.error(
          `That image is still ${formatBytes(prepared.file.size)} after preparation. The limit is ${formatBytes(maxMediaBytes)}.`,
        );
        return;
      }
      // A document fallback may be a format the browser cannot render (HEIC)
      // or an animated file we are deliberately not rasterising. Show the
      // file row instead of a broken or misleading image preview.
      const preview = prepared.asDocument ? null : URL.createObjectURL(prepared.file);
      pendingUrlRef.current = preview;
      setPending({
        file: prepared.file,
        kind,
        preview,
        caption: '',
        voice: false,
        asDocument: prepared.asDocument,
        notice: prepared.notice,
        displayName: file.name,
        converted: prepared.converted,
      });
      if (prepared.notice) toast.info(prepared.notice);
      return;
    }

    if (maxMediaBytes && file.size > maxMediaBytes) {
      toast.error(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxMediaBytes)}.`);
      return;
    }
    const preview = kind === 'video' || kind === 'audio' ? URL.createObjectURL(file) : null;
    pendingUrlRef.current = preview;
    setPending({
      file,
      kind,
      preview,
      caption: '',
      voice: false,
      asDocument: kind === 'document',
      notice: null,
      displayName: file.name,
      converted: false,
    });
  }

  async function sendText() {
    const text = draft.trim();
    if (!text || busyRef.current) return;
    busyRef.current = 'text';
    setBusy('text');
    try {
      await onSendText(text, replyTo?.id ?? null, newSendKey());
      setDraft('');
      onCancelReply?.();
    } catch (error) {
      toast.error(error?.message ?? 'The message could not be sent.');
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  async function sendPending() {
    if (!pending || busyRef.current || preparing) return;
    busyRef.current = 'media';
    setBusy('media');
    try {
      await onSendMedia({
        file: pending.file,
        caption: pending.caption,
        voice: pending.voice,
        asDocument: pending.asDocument || pending.kind === 'document',
        replyToMessageId: replyTo?.id ?? null,
        idempotencyKey: newSendKey(),
      });
      clearPending();
      onCancelReply?.();
    } catch (error) {
      toast.error(error?.message ?? 'The attachment could not be sent.');
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  async function startRecording() {
    setEmojiOpen(false);
    await recorder.start();
  }

  async function sendRecording() {
    if (busyRef.current) return;
    busyRef.current = 'voice';
    setBusy('voice');
    try {
      const result = await recorder.stop();
      if (!result) return;
      const file = new File([result.blob], voiceFileName(result.mimeType), { type: result.mimeType });
      await onSendMedia({
        file,
        caption: '',
        voice: true,
        asDocument: false,
        replyToMessageId: replyTo?.id ?? null,
        idempotencyKey: newSendKey(),
      });
      onCancelReply?.();
    } catch (error) {
      toast.error(error?.message ?? 'The voice note could not be sent.');
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  function insertEmoji(emoji) {
    const textarea = textareaRef.current;
    if (!textarea) {
      setDraft((value) => `${value}${emoji}`);
      return;
    }
    const start = textarea.selectionStart ?? draft.length;
    const end = textarea.selectionEnd ?? draft.length;
    const next = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    setDraft(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const position = start + emoji.length;
      textarea.setSelectionRange(position, position);
    });
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendText();
    }
  }

  if (!canSend) {
    return (
      <div className="border-t p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
          <div>
            <p className="text-sm font-medium">Sending is unavailable</p>
            <p className="text-xs text-muted-foreground">
              {capabilities?.outboundMessaging
                ? 'This chat is read-only right now.'
                : 'The selected connector cannot send messages. Connect the instance first.'}
            </p>
          </div>
          {onOpenConnect ? (
            <Button type="button" size="sm" onClick={onOpenConnect}>
              Open connection
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="border-t bg-background/95 p-2 sm:p-3">
      <input ref={fileInputRef} type="file" className="hidden" onChange={onFilePicked} aria-hidden="true" />

      {replyTo ? (
        <div className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-emerald-500 bg-muted/60 px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Replying to</p>
            <p className="truncate text-xs">{replyTo.body || replyTo.caption || 'Message'}</p>
          </div>
          <Button type="button" size="icon" variant="ghost" className="size-6" onClick={onCancelReply} aria-label="Cancel reply">
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {recorder.error ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          <span>{recorder.error}</span>
          <Button type="button" size="icon" variant="ghost" className="size-6" onClick={recorder.clearError} aria-label="Dismiss">
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {recorder.state === 'recording' ? (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <span className="size-2.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          <span className="text-sm font-medium tabular-nums">{formatSeconds(recorder.seconds)}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Recording a voice note · up to {formatSeconds(recorder.maxSeconds)}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={recorder.cancel} disabled={busy === 'voice'}>
            <Trash2 aria-hidden="true" />
            Discard
          </Button>
          <Button type="button" size="sm" onClick={sendRecording} disabled={busy === 'voice'}>
            {busy === 'voice' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            Send
          </Button>
        </div>
      ) : null}

      {preparing ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Preparing photo for WhatsApp…
        </div>
      ) : null}

      {pending ? (
        <div className="mb-2 space-y-2 rounded-lg border p-2">
          <div className="flex items-center gap-2">
            {pending.kind === 'image' && pending.preview ? (
              <img src={pending.preview} alt="Attachment preview" className="size-14 rounded-md object-cover" />
            ) : pending.kind === 'video' && pending.preview ? (
              <video src={pending.preview} className="size-14 rounded-md object-cover" muted />
            ) : pending.kind === 'audio' && pending.preview ? (
              <audio src={pending.preview} controls className="h-9 min-w-0 flex-1" />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                <FileText className="size-4" aria-hidden="true" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{pending.displayName || pending.file.name || 'Attachment'}</p>
              <p className="text-[10px] text-muted-foreground">
                {formatFileKind(pending.file.type)} · {formatBytes(pending.file.size)}
                {pending.asDocument ? ' · sent as a file' : ''}
                {pending.converted ? ' · compressed' : ''}
                {pending.voice ? ' · voice note' : ''}
              </p>
            </div>
            <Button type="button" size="icon" variant="ghost" className="size-8" onClick={clearPending} aria-label="Remove attachment">
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {pending.notice ? (
            <p className="rounded bg-amber-50 px-2 py-1 text-[10px] leading-snug text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {pending.notice}
            </p>
          ) : null}
          {pending.kind !== 'audio' ? (
            <Input
              value={pending.caption}
              onChange={(event) => setPending((previous) => ({ ...previous, caption: event.target.value }))}
              placeholder="Add a caption (optional)"
              maxLength={1024}
              className="h-8 text-xs"
            />
          ) : (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={pending.voice}
                onChange={(event) => setPending((previous) => ({ ...previous, voice: event.target.checked }))}
                className="size-3.5 accent-primary"
              />
              Send as a WhatsApp voice note
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={clearPending} disabled={busy === 'media'}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={sendPending} disabled={busy === 'media' || preparing}>
              {busy === 'media' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              Send
            </Button>
          </div>
        </div>
      ) : null}

      {emojiOpen ? (
        <div className="mb-2 grid grid-cols-10 gap-1 rounded-lg border bg-popover p-2 shadow-sm">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => insertEmoji(emoji)}
              className="rounded p-1 text-lg hover:bg-accent"
              aria-label={`Insert ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-1.5">
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => pickFile('image/*,video/*,audio/*,application/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt')}
            disabled={!canMedia || Boolean(pending) || preparing}
            aria-label="Attach a file"
            title="Attach a file"
          >
            <Paperclip aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => pickFile('image/*,video/*')}
            disabled={!canMedia || Boolean(pending) || preparing}
            aria-label="Send a photo or video"
            title="Photo or video"
          >
            <ImageIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setEmojiOpen((value) => !value)}
            aria-label="Emoji"
            title="Emoji"
          >
            <Smile aria-hidden="true" />
          </Button>
        </div>

        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a message…"
          rows={1}
          maxLength={4096}
          className="min-h-10 max-h-[132px] flex-1 resize-none py-2"
          aria-label="Message"
        />

        <div className="flex items-center gap-0.5">
          {canPoll ? (
            <Button type="button" size="icon" variant="ghost" onClick={() => setDialog('poll')} aria-label="Create a poll" title="Create a poll">
              <BarChart3 aria-hidden="true" />
            </Button>
          ) : null}
          {canLocation ? (
            <Button type="button" size="icon" variant="ghost" onClick={() => setDialog('location')} aria-label="Share a location" title="Share a location">
              <MapPin aria-hidden="true" />
            </Button>
          ) : null}
          {canContact ? (
            <Button type="button" size="icon" variant="ghost" onClick={() => setDialog('contact')} aria-label="Send a contact" title="Send a contact">
              <Contact aria-hidden="true" />
            </Button>
          ) : null}

          {draft.trim() ? (
            <Button type="button" size="icon" onClick={sendText} disabled={busy === 'text'} aria-label="Send message" title="Send (Enter)">
              {busy === 'text' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            </Button>
          ) : recorder.supported ? (
            <Button
              type="button"
              size="icon"
              variant={recorder.state === 'recording' ? 'destructive' : 'default'}
              onClick={recorder.state === 'recording' ? sendRecording : startRecording}
              disabled={Boolean(pending) || recorder.state === 'processing' || busy === 'voice'}
              aria-label={recorder.state === 'recording' ? 'Stop and send voice note' : 'Record a voice note'}
              title={recorder.state === 'recording' ? 'Stop and send' : 'Record a voice note'}
            >
              {recorder.state === 'processing' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : recorder.state === 'recording' ? (
                <Square aria-hidden="true" />
              ) : (
                <Mic aria-hidden="true" />
              )}
            </Button>
          ) : (
            <Button type="button" size="icon" disabled aria-label="Send message">
              <Send aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground">
        <span>Enter sends · Shift+Enter adds a line</span>
        <span className="tabular-nums">{draft.length > 3600 ? `${draft.length}/4096` : ''}</span>
      </div>

      <PollDialog
        open={dialog === 'poll'}
        onOpenChange={(open) => setDialog(open ? 'poll' : null)}
        sending={busy === 'poll'}
        onSubmit={async (payload) => {
          setBusy('poll');
          try {
            await onSendPoll(payload, replyTo?.id ?? null);
            onCancelReply?.();
          } finally {
            setBusy(null);
          }
        }}
      />
      <LocationDialog
        open={dialog === 'location'}
        onOpenChange={(open) => setDialog(open ? 'location' : null)}
        sending={busy === 'location'}
        onSubmit={async (payload) => {
          setBusy('location');
          try {
            await onSendLocation(payload, replyTo?.id ?? null);
            onCancelReply?.();
          } finally {
            setBusy(null);
          }
        }}
      />
      <ContactDialog
        open={dialog === 'contact'}
        onOpenChange={(open) => setDialog(open ? 'contact' : null)}
        connector={connector}
        sending={busy === 'contact'}
        onSubmit={async (payload) => {
          setBusy('contact');
          try {
            await onSendContact(payload, replyTo?.id ?? null);
            onCancelReply?.();
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}
