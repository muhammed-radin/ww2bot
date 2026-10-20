/**
 * Conversation presentation helpers.
 *
 * The backend deliberately exposes only what WhatsApp actually reported. These
 * helpers turn that shape into labels; they never invent a message type, a
 * sender, or a delivery state.
 */

export const REACTION_PALETTE = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const MESSAGE_TYPE_LABELS = Object.freeze({
  chat: 'Text',
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  ptt: 'Voice message',
  voice: 'Voice message',
  document: 'Document',
  sticker: 'Sticker',
  location: 'Location',
  live_location: 'Live location',
  vcard: 'Contact',
  multi_vcard: 'Contacts',
  poll_creation: 'Poll',
  call_log: 'Call',
  revoked: 'Deleted message',
  reaction: 'Reaction',
  notification: 'Notice',
  e2e_notification: 'Security notice',
  group_notification: 'Group notice',
  broadcast_notification: 'Broadcast notice',
  order: 'Order',
  product: 'Product',
  payment: 'Payment',
  buttons_response: 'Button reply',
  list_response: 'List reply',
  template_button_reply: 'Button reply',
  unknown: 'Message',
});

const SYSTEM_TYPES = new Set([
  'notification',
  'e2e_notification',
  'group_notification',
  'broadcast_notification',
  'gp2',
  'protocol',
  'debug',
]);

const AVATAR_TONES = [
  'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
];

export function messageTypeLabel(type) {
  return MESSAGE_TYPE_LABELS[type] ?? MESSAGE_TYPE_LABELS.unknown;
}

export function isSystemMessage(message) {
  return Boolean(message?.isNotification) || SYSTEM_TYPES.has(message?.type);
}

export function isCallLog(message) {
  return message?.type === 'call_log';
}

export function isRevoked(message) {
  return Boolean(message?.isRevoked) || message?.type === 'revoked';
}

export function messageKind(message) {
  if (!message) return 'unknown';
  if (isRevoked(message)) return 'revoked';
  if (isSystemMessage(message)) return 'system';
  if (isCallLog(message)) return 'call';
  if (message.poll) return 'poll';
  if (message.location) return 'location';
  if (Array.isArray(message.contacts) && message.contacts.length > 0) return 'contact';
  const type = String(message.type ?? '').toLowerCase();
  if (type === 'ptt' || type === 'voice' || message.media?.isPtt) return 'voice';
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  if (type === 'document') return 'document';
  if (type === 'sticker') return 'sticker';
  if (type === 'reaction') return 'reaction';
  if (message.hasMedia || message.media) return 'document';
  if (typeof message.body === 'string' && message.body.trim() !== '') return 'text';
  return 'unknown';
}

export function mediaKindLabel(message) {
  const kind = messageKind(message);
  if (kind === 'image') return 'Photo';
  if (kind === 'video') return 'Video';
  if (kind === 'voice') return 'Voice message';
  if (kind === 'audio') return 'Audio';
  if (kind === 'document') return message.media?.filename || 'Document';
  if (kind === 'sticker') return 'Sticker';
  return messageTypeLabel(message?.type);
}

export function chatDisplayName(chat) {
  if (chat?.displayName && String(chat.displayName).trim() !== '') return String(chat.displayName);
  const id = String(chat?.chatId ?? '');
  if (id.endsWith('@g.us')) return 'Group chat';
  if (id.endsWith('@lid')) return 'WhatsApp contact';
  const user = id.split('@')[0];
  if (user && /^\d{5,}$/.test(user)) return `+${user}`;
  return user || 'Unknown chat';
}

export function chatInitials(chat) {
  const name = chatDisplayName(chat);
  if (/^\+\d/.test(name)) return name.replace(/\D/g, '').slice(-2);
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function avatarTone(id) {
  const value = String(id ?? '');
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function chatKind(chat) {
  const id = String(chat?.chatId ?? '');
  if (id.endsWith('@g.us')) return 'Group';
  if (id.endsWith('@lid')) return 'Linked identity';
  if (id.endsWith('@broadcast')) return 'Broadcast';
  if (id.endsWith('@newsletter')) return 'Channel';
  return 'Direct chat';
}

export function chatPhone(chat) {
  const id = String(chat?.chatId ?? '');
  // A LID (`...@lid`), group, broadcast or channel id is not a phone number.
  // Displaying its numeric local part as `+…` would invent a phone number.
  const [user, server] = id.split('@');
  if (server && server !== 'c.us') return null;
  return /^\d{5,}$/.test(user) ? `+${user}` : null;
}

export function messagePreview(message) {
  if (!message) return 'No messages yet';
  const kind = messageKind(message);
  if (kind === 'revoked') return 'This message was deleted';
  if (kind === 'call') {
    const direction = message.subtype === 'missed' ? 'Missed call' : 'Call';
    return message.fromMe ? `${direction} · outgoing` : direction;
  }
  if (kind === 'poll') return `Poll: ${message.poll?.question ?? ''}`.trim();
  if (kind === 'location') return `Location: ${message.location?.name || message.location?.address || 'shared pin'}`;
  if (kind === 'contact') {
    const names = message.contacts.map((contact) => contact.name).filter(Boolean);
    return `Contact: ${names.join(', ') || 'shared card'}`;
  }
  if (kind === 'image') return message.caption || 'Photo';
  if (kind === 'video') return message.caption || 'Video';
  if (kind === 'voice') return 'Voice message';
  if (kind === 'audio') return message.media?.filename || 'Audio';
  if (kind === 'document') return message.media?.filename || 'Document';
  if (kind === 'sticker') return 'Sticker';
  if (kind === 'reaction') return 'Reacted to a message';
  const body = String(message.body ?? '').replace(/\s+/g, ' ').trim();
  if (body) return body;
  return messageTypeLabel(message.type);
}

export function previewWithAuthor(message) {
  const preview = messagePreview(message);
  return message?.fromMe ? `You: ${preview}` : preview;
}

export function truncate(value, length = 84) {
  const text = String(value ?? '');
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(length - 1, 0))}…`;
}

export function formatPhoneNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 7) return String(value ?? '');
  return `+${digits}`;
}

export function reactionSummary(reactions) {
  const counts = new Map();
  for (const reaction of reactions ?? []) {
    const emoji = reaction?.emoji;
    if (!emoji) continue;
    const count = Array.isArray(reaction.senders) ? reaction.senders.length : 1;
    counts.set(emoji, (counts.get(emoji) ?? 0) + count);
  }
  return [...counts.entries()].map(([emoji, count]) => ({ emoji, count }));
}

export function pollTally(poll, voteResult) {
  const rawOptions = voteResult?.options?.length ? voteResult.options : (poll?.options ?? []);
  // A retained outbound poll may carry plain option names; normalise both
  // shapes so the tally does not depend on which store produced the message.
  const options = rawOptions.map((option, index) =>
    typeof option === 'string' ? { name: option, localId: index } : option,
  );
  const counts = new Map(options.map((option) => [option.localId, 0]));
  for (const vote of voteResult?.votes ?? []) {
    for (const localId of vote.selectedOptionLocalIds ?? []) {
      counts.set(localId, (counts.get(localId) ?? 0) + 1);
    }
  }
  const total = (voteResult?.votes ?? []).length;
  return {
    total,
    options: options.map((option) => ({
      ...option,
      votes: counts.get(option.localId) ?? 0,
      percent: total === 0 ? 0 : Math.round(((counts.get(option.localId) ?? 0) / total) * 100),
    })),
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function formatFileKind(mimeType) {
  const value = String(mimeType ?? '').toLowerCase();
  if (value.startsWith('image/')) return 'Image';
  if (value.startsWith('video/')) return 'Video';
  if (value.startsWith('audio/')) return 'Audio';
  if (value === 'application/pdf') return 'PDF';
  if (value.includes('spreadsheet') || value.includes('excel')) return 'Spreadsheet';
  if (value.includes('word') || value.includes('document')) return 'Document';
  if (value.includes('zip') || value.includes('compressed')) return 'Archive';
  return 'File';
}
