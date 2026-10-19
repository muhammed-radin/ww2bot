/**
 * Read-only data API: chats and contacts.
 *
 * Every request is capability-aware. A connector that cannot serve an endpoint
 * raises CAPABILITY_NOT_SUPPORTED (501) with an explanation rather than
 * returning invented data, and any connector-specific caveats are returned in a
 * `limitations` array.
 */
import { Router } from 'express';
import { ROUTE_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { assertDateWindow } from '../middleware/validateRequest.js';
import { nextCursorFrom, parsePagination } from '../utils/pagination.js';
import { chatIdParams, listChatsQuery, listContactsQuery } from '../validators/message.validator.js';
import { instanceIdParams } from '../validators/instance.validator.js';
import { ok, paginationMeta } from '../utils/respond.js';

export function createChatsRouter({ config, connectionService, cursorCodec, requireScopes, rateLimit, loadInstance }) {
  const router = Router({ mergeParams: true });

  router.get(
    '/chats',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: instanceIdParams, query: listChatsQuery }),
    loadInstance,
    async (req, res) => {
      const { since, until } = req.valid.query;
      assertDateWindow(since, until);
      const { limit, cursor } = parsePagination(req.valid.query, config.pagination, { kind: 'chats', codec: cursorCodec });

      const connector = connectionService.requireConnector(req.instance);
      const result = await connector.listChats({ limit, cursor, since: since ?? null, until: until ?? null });
      const nextCursor = nextCursorFrom(
        result.items,
        result.hasMore,
        (chat) => ({ t: chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : 0, i: chat.chatId }),
        cursorCodec,
        'chats',
      );

      ok(
        res,
        { items: result.items, limitations: result.limitations ?? [] },
        { pagination: paginationMeta({ limit, hasMore: Boolean(result.hasMore), nextCursor, returned: result.items.length }) },
      );
    },
  );

  router.get(
    '/chats/:chatId',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: chatIdParams }),
    loadInstance,
    async (req, res) => {
      const connector = connectionService.requireConnector(req.instance);
      const chat = await connector.getChat(req.valid.params.chatId);
      if (!chat) {
        // A chat id supplied by the caller is never assumed to be authorised.
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Chat not found.' },
          requestId: req.id,
        });
      }
      return ok(res, chat);
    },
  );

  router.get(
    '/contacts',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: instanceIdParams, query: listContactsQuery }),
    loadInstance,
    async (req, res) => {
      const { limit, cursor } = parsePagination(req.valid.query, config.pagination, { kind: 'contacts', codec: cursorCodec });
      const connector = connectionService.requireConnector(req.instance);
      const result = await connector.listContacts({ limit, cursor });
      const nextCursor = nextCursorFrom(
        result.items,
        result.hasMore,
        (contact) => ({ t: 0, i: contact.contactId }),
        cursorCodec,
        'contacts',
      );
      ok(
        res,
        { items: result.items, limitations: result.limitations ?? [] },
        { pagination: paginationMeta({ limit, hasMore: Boolean(result.hasMore), nextCursor, returned: result.items.length }) },
      );
    },
  );

  return router;
}
