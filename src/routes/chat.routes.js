/**
 * Per-chat actions used by the owner dashboard's conversation page.
 *
 * Reads stay capability-aware, exactly like the read-only data routes. Sends
 * run through OutboundService so idempotency, recipient rate limits, audit
 * records and retention behave the same as the public `/messages/send` route.
 *
 * Media uploads use `application/octet-stream` with metadata in headers, not
 * the JSON body. That keeps the strict 100 kb JSON limit intact for every other
 * route while allowing large media without adding a multipart dependency.
 */
import { Router } from 'express';
import express from 'express';
import { ROUTE_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { ok } from '../utils/respond.js';
import { ValidationError } from '../utils/errors.js';
import {
  boolFromQuery,
  chatIdParams,
  chatMessageParams,
  sendContactBody,
  sendLocationBody,
  sendMediaQuery,
  sendPollBody,
  sendReactionBody,
  sendTextBody,
} from '../validators/message.validator.js';

const MAX_FILENAME_LENGTH = 255;
const MAX_CAPTION_LENGTH = 1024;

function decodeHeader(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8').trim();
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

function cleanFilename(value) {
  if (typeof value !== 'string') return null;
  const base = value.split(/[/\\]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? '';
  if (!base) return null;
  return base.slice(0, MAX_FILENAME_LENGTH);
}

function inferMediaType(mimetype, query) {
  if (boolFromQuery(query.sticker)) return 'sticker';
  if (boolFromQuery(query.voice)) return 'voice';
  if (boolFromQuery(query.document)) return 'document';
  const value = String(mimetype ?? '').toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  return 'document';
}

function safeInlineMime(mimetype) {
  const value = String(mimetype ?? '').toLowerCase().split(';')[0].trim();
  if (value === 'image/svg+xml' || value === 'text/html' || value === 'application/xhtml+xml') return false;
  return (
    value.startsWith('image/') ||
    value.startsWith('audio/') ||
    value.startsWith('video/') ||
    value === 'application/pdf'
  );
}

function contentDisposition(filename, inline) {
  const fallback = (filename || 'media').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const encoded = encodeURIComponent(filename || 'media');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function createChatActionsRouter({
  config,
  connectionService,
  outboundService,
  requireScopes,
  rateLimit,
  loadInstance,
}) {
  const router = Router({ mergeParams: true });
  const mediaLimit = config.media?.maxUploadBytes ?? 16 * 1024 * 1024;

  async function send(req, res, payload) {
    const headerKey = req.get('idempotency-key') ?? null;
    const result = await outboundService.send(req.instance, req.auth, {
      ...payload,
      to: req.valid.params.chatId,
      idempotencyKey: headerKey ?? payload.idempotencyKey ?? null,
      requestId: req.id,
      ip: req.ip,
    });
    return ok(res, result);
  }

  /* -------------------------------- text -------------------------------- */

  router.post(
    '/chats/:chatId/messages',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatIdParams, body: sendTextBody }),
    loadInstance,
    async (req, res) => {
      const body = req.valid.body;
      return send(req, res, {
        type: 'text',
        text: body.text,
        replyToMessageId: body.replyToMessageId,
        idempotencyKey: body.idempotencyKey,
      });
    },
  );

  /* ------------------------------- media -------------------------------- */

  router.post(
    '/chats/:chatId/messages/media',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatIdParams, query: sendMediaQuery }),
    loadInstance,
    express.raw({ type: 'application/octet-stream', limit: mediaLimit }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ValidationError('The request body must contain the media bytes.', { field: 'body' });
      }
      if (req.body.length > mediaLimit) {
        throw new ValidationError(`Media must not exceed ${mediaLimit} bytes.`, { field: 'body', maxBytes: mediaLimit });
      }
      const mimetype = String(req.get('x-media-mimetype') ?? '').trim();
      if (!mimetype || mimetype.length > 120 || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:\s*;.*)?$/.test(mimetype)) {
        throw new ValidationError('The X-Media-Mimetype header must contain a valid MIME type.', {
          field: 'x-media-mimetype',
        });
      }
      const filename = cleanFilename(decodeHeader(req.get('x-media-filename')));
      const caption = decodeHeader(req.get('x-media-caption'));
      if (caption && caption.length > MAX_CAPTION_LENGTH) {
        throw new ValidationError(`The caption must not exceed ${MAX_CAPTION_LENGTH} characters.`, {
          field: 'x-media-caption',
        });
      }
      const query = req.valid.query;
      const type = inferMediaType(mimetype, query);
      return send(req, res, {
        type,
        media: {
          mimetype,
          data: req.body.toString('base64'),
          filename,
          size: req.body.length,
        },
        caption,
        filename,
        voice: boolFromQuery(query.voice),
        asDocument: boolFromQuery(query.document),
        asSticker: boolFromQuery(query.sticker),
        asGif: boolFromQuery(query.gif),
        isViewOnce: boolFromQuery(query.viewOnce),
        replyToMessageId: query.replyToMessageId,
        idempotencyKey: query.idempotencyKey,
      });
    },
  );

  router.get(
    '/chats/:chatId/messages/:messageId/media',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: chatMessageParams }),
    loadInstance,
    async (req, res) => {
      const connector = connectionService.requireConnector(req.instance);
      const media = await connector.downloadMedia({
        chatId: req.valid.params.chatId,
        messageId: req.valid.params.messageId,
      });
      if (!media) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'MEDIA_UNAVAILABLE',
            message: 'This media is no longer available on the linked device. It may have expired, been deleted, or still be downloading on the phone.',
          },
          requestId: req.id,
        });
      }
      const mimetype = typeof media.mimetype === 'string' && media.mimetype ? media.mimetype : 'application/octet-stream';
      const buffer = Buffer.from(String(media.data ?? ''), 'base64');
      if (buffer.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: 'MEDIA_UNAVAILABLE', message: 'This media is empty or could not be downloaded.' },
          requestId: req.id,
        });
      }
      const inline = safeInlineMime(mimetype);
      res.setHeader('Content-Type', mimetype);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Content-Disposition', contentDisposition(media.filename, inline));
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).end(buffer);
    },
  );

  /* ------------------------------- poll --------------------------------- */

  router.post(
    '/chats/:chatId/messages/poll',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatIdParams, body: sendPollBody }),
    loadInstance,
    async (req, res) => {
      const body = req.valid.body;
      return send(req, res, {
        type: 'poll',
        poll: {
          question: body.question,
          options: body.options,
          allowMultipleAnswers: Boolean(body.allowMultipleAnswers),
        },
        replyToMessageId: body.replyToMessageId,
        idempotencyKey: body.idempotencyKey,
      });
    },
  );

  router.get(
    '/chats/:chatId/messages/:messageId/poll-votes',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: chatMessageParams }),
    loadInstance,
    async (req, res) => {
      const connector = connectionService.requireConnector(req.instance);
      const result = await connector.getPollVotes({
        chatId: req.valid.params.chatId,
        messageId: req.valid.params.messageId,
      });
      return ok(res, result);
    },
  );

  /* ----------------------------- location ------------------------------- */

  router.post(
    '/chats/:chatId/messages/location',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatIdParams, body: sendLocationBody }),
    loadInstance,
    async (req, res) => {
      const body = req.valid.body;
      return send(req, res, {
        type: 'location',
        location: {
          latitude: body.latitude,
          longitude: body.longitude,
          name: body.name,
          address: body.address,
          url: body.url,
        },
        replyToMessageId: body.replyToMessageId,
        idempotencyKey: body.idempotencyKey,
      });
    },
  );

  /* ------------------------------ contact ------------------------------- */

  router.post(
    '/chats/:chatId/messages/contact',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatIdParams, body: sendContactBody }),
    loadInstance,
    async (req, res) => {
      const body = req.valid.body;
      return send(req, res, {
        type: 'contact',
        contactId: body.contactId,
        contact: body.contact,
        replyToMessageId: body.replyToMessageId,
        idempotencyKey: body.idempotencyKey,
      });
    },
  );

  /* ------------------------------ reaction ------------------------------ */

  router.post(
    '/chats/:chatId/messages/:messageId/reaction',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatMessageParams, body: sendReactionBody }),
    loadInstance,
    async (req, res) => {
      const result = await outboundService.send(req.instance, req.auth, {
        to: req.valid.params.chatId,
        type: 'reaction',
        messageId: req.valid.params.messageId,
        reaction: req.valid.body.reaction,
        requestId: req.id,
        ip: req.ip,
      });
      return ok(res, result);
    },
  );

  router.get(
    '/chats/:chatId/messages/:messageId/reactions',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: chatMessageParams }),
    loadInstance,
    async (req, res) => {
      const connector = connectionService.requireConnector(req.instance);
      const reactions = await connector.getMessageReactions({
        chatId: req.valid.params.chatId,
        messageId: req.valid.params.messageId,
      });
      return ok(res, { reactions });
    },
  );

  /* -------------------------------- seen -------------------------------- */

  router.post(
    '/chats/:chatId/seen',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ params: chatIdParams }),
    loadInstance,
    async (req, res) => {
      const connector = connectionService.requireConnector(req.instance);
      const result = await connector.markChatSeen(req.valid.params.chatId);
      return ok(res, result);
    },
  );

  return router;
}
