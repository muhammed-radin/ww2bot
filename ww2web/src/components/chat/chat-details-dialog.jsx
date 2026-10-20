import { AlertTriangle, Info } from 'lucide-react';
import { ChatAvatar } from '@/components/chat/avatar.jsx';
import { CopyableValue } from '@/components/common/copy-button.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx';
import { Separator } from '@/components/ui/separator.jsx';
import { chatDisplayName, chatKind, chatPhone } from '@/lib/chat.js';
import { formatDateTime } from '@/lib/format.js';

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/** Conversation metadata and the selected connector's honest limitations. */
export function ChatDetailsDialog({ chat, capabilities, instance, open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Conversation details</DialogTitle>
          <DialogDescription>What the selected connector actually exposes for this chat.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <ChatAvatar chat={chat} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{chatDisplayName(chat)}</p>
            <p className="truncate text-xs text-muted-foreground">{chatKind(chat)}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {chat?.isGroup ? <Badge variant="muted">Group</Badge> : <Badge variant="muted">Direct</Badge>}
              {chat?.pinned ? <Badge variant="outline">Pinned</Badge> : null}
              {chat?.isMuted ? <Badge variant="outline">Muted</Badge> : null}
              {Number(chat?.unreadCount ?? 0) > 0 ? <Badge variant="success">{chat.unreadCount} unread</Badge> : null}
            </div>
          </div>
        </div>

        <Separator />

        <div className="divide-y">
          <Row label="Chat id">
            {chat?.chatId ? <CopyableValue value={chat.chatId} className="justify-end" /> : '—'}
          </Row>
          <Row label="Phone">{chatPhone(chat) || 'Not a phone-number chat id'}</Row>
          <Row label="Instance">{instance?.displayName || instance?.id || '—'}</Row>
          <Row label="Connector">
            {capabilities?.connector === 'web'
              ? 'WhatsApp Web (linked device)'
              : capabilities?.connector === 'cloud_api'
                ? 'Cloud API'
                : '—'}
          </Row>
          <Row label="Last activity">{chat?.lastMessageAt ? formatDateTime(chat.lastMessageAt) : '—'}</Row>
          <Row label="Message history">
            {capabilities?.connector === 'web'
              ? 'Recent linked-device window only'
              : capabilities?.historicalMessages === false
                ? 'What this gateway retained'
                : 'What the connector can serve'}
          </Row>
          <Row label="Content retention">
            {capabilities?.messageContentRetention === 'enabled' ? 'Enabled for this instance' : 'Not retained by this instance'}
          </Row>
        </div>

        <div className="rounded-md border bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <Info className="size-3.5" aria-hidden="true" />
            Connector limitations
          </p>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            {(capabilities?.limitations ?? ['No connector limitations were reported.']).map((limitation) => (
              <li key={limitation} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{limitation}</span>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
