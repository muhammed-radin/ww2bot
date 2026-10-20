import { avatarTone, chatDisplayName, chatInitials } from '@/lib/chat.js';

const SIZES = {
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-10 w-10 text-xs',
  lg: 'h-12 w-12 text-sm',
  xl: 'h-16 w-16 text-lg',
};

/**
 * Initials avatar. WhatsApp profile photos are not fetched: doing so would add
 * a second network path that can fail independently and would leak more than the
 * conversation data the operator asked for. Initials are deterministic.
 */
export function ChatAvatar({ chat, size = 'md', className = '' }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${SIZES[size] ?? SIZES.md} ${avatarTone(chat?.chatId)} ${className}`}
      aria-hidden="true"
      title={chatDisplayName(chat)}
    >
      {chatInitials(chat)}
    </div>
  );
}
