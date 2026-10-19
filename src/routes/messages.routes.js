/**
 * Read-only message endpoint.
 *
 * Kept separate from chats so the cursor kind, date filters and direction
 * filter are validated in one place. Two read shapes are served:
 *   - `/messages` — instance-wide recorded history (incoming and outgoing);
 *   - `/chats/:chatId/messages` — one conversation.
 * What is available is exactly what the selected connector can provide:
 *   - Cloud API: messages this gateway recorded (inbound webhooks and outbound
 *     sends) while retention is enabled;
 *   - WhatsApp Web: the bounded recent window the linked device exposes.
 */
import { Router } from 'express';
import { ROUTE_SCOPES } from '../config/security.js';
import { assertDateWindow, validate } from '../middleware/validateRequest.js';
import { nextCursorFrom, parsePagination } from '../utils/pagination.js';
import { chatIdParams, chatMessagesQuery, listMessagesQuery, messageIdParams } from '../validators/message.validator.js';
import { instanceIdParams } from '../validators/instance.validator.js';
import { ok, paginationMeta } from '../utils/respond.js';

export function createMessagesRouter({ config, connectionService, cursorCodec, requireScopes, rateLimit, loadInstance }) {
  const router = Router({ mergeParams: true });

  // Instance-wide recorded history (incoming and outgoing). This is the REST
  // half of the live feed; the SSE half is `message.received`/`message.sent`
  // on the connection event stream.
  router.get(
    '/messages',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: instanceIdParams, query: listMessagesQuery }),
    loadInstance,
    async (req, res) => {
      const { since, until, direction, chatId } = req.valid.query;
      assertDateWindow(since, until);
      const { limit, cursor } = parsePagination(req.valid.query, config.pagination, {
        kind: 'messages',
        codec: cursorCodec,
      });
      const result = await connectionService.listRecentMessages(req.instance, {
        limit,
        cursor,
        since: since ?? null,
        until: until ?? null,
        direction: direction ?? null,
        chatId: chatId ?? null,
      });
      const nextCursor = nextCursorFrom(
        result.items,
        result.hasMore,
        (message) => ({
          t: message.timestamp ? new Date(message.timestamp).getTime() : 0,
          i: message.storedId ?? message.id,
        }),
        cursorCodec,
        'messages',
      );
      return ok(
        res,
        { items: result.items, limitations: result.limitations ?? [] },
        { pagination: paginationMeta({ limit, hasMore: Boolean(result.hasMore), nextCursor, returned: result.items.length }) },
      );
    },
  );

  router.get(
    '/messages/:messageId',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: messageIdParams }),
    loadInstance,
    async (req, res) => {
      const message = await connectionService.getMessageById(req.instance, req.valid.params.messageId);
      if (!message) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Message not found.' },
          requestId: req.id,
        });
      }
      return ok(res, { message });
    },
  );

  router.get(
    '/chats/:chatId/messages',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: chatIdParams, query: chatMessagesQuery }),
    loadInstance,
    async (req, res) => {
      const { since, until, direction } = req.valid.query;
      assertDateWindow(since, until);
      const { limit, cursor } = parsePagination(req.valid.query, config.pagination, {
        kind: 'messages',
        codec: cursorCodec,
      });

      const connector = connectionService.requireConnector(req.instance);
      const result = await connector.listMessages(req.valid.params.chatId, {
        limit,
        cursor,
        since: since ?? null,
        until: until ?? null,
        direction: direction ?? null,
      });

      if (result === null) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Chat not found.' },
          requestId: req.id,
        });
      }

      const items = direction ? result.items.filter((message) => message.direction === direction) : result.items;
      const nextCursor = nextCursorFrom(
        items,
        result.hasMore,
        (message) => ({
          t: message.timestamp ? new Date(message.timestamp).getTime() : 0,
          i: message.storedId ?? message.id,
        }),
        cursorCodec,
        'messages',
      );

      return ok(
        res,
        { items, limitations: result.limitations ?? [] },
        { pagination: paginationMeta({ limit, hasMore: Boolean(result.hasMore), nextCursor, returned: items.length }) },
      );
    },
  );

  return router;
}
