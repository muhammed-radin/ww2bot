/**
 * Validation schemas for the read-only data routes.
 */
import { z } from 'zod';
import { chatIdParams, dateFilters, instanceIdParams, paginationQuery } from '../middleware/validateRequest.js';

export const listChatsQuery = paginationQuery.merge(dateFilters);

export const chatMessagesQuery = paginationQuery.merge(dateFilters).extend({
  direction: z.enum(['inbound', 'outbound']).optional(),
});

export const listMessagesQuery = paginationQuery.merge(dateFilters).extend({
  direction: z.enum(['inbound', 'outbound']).optional(),
  chatId: z.string().min(3).max(80).optional(),
});

export const messageIdParams = instanceIdParams.extend({
  messageId: z.string().min(1).max(200),
});

export const listContactsQuery = paginationQuery;

export const chatParams = chatIdParams;

export { chatIdParams };
