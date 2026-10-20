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

export const chatMessageParams = chatIdParams.extend({
  messageId: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9@._:$+-]+$/, 'must be a valid message id'),
});

export const listContactsQuery = paginationQuery;

export const chatParams = chatIdParams;

/* ------------------------------- send actions ------------------------------ */

const replyToMessageId = z.string().min(3).max(200).optional();

export const sendTextBody = z.object({
  text: z.string().min(1, 'must not be empty').max(4096),
  replyToMessageId,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const sendMediaQuery = z.object({
  voice: z.enum(['true', 'false', '1', '0']).optional(),
  document: z.enum(['true', 'false', '1', '0']).optional(),
  sticker: z.enum(['true', 'false', '1', '0']).optional(),
  gif: z.enum(['true', 'false', '1', '0']).optional(),
  viewOnce: z.enum(['true', 'false', '1', '0']).optional(),
  replyToMessageId: z.string().min(3).max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const sendLocationBody = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  url: z.string().url().max(500).optional(),
  replyToMessageId,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const sendContactBody = z
  .object({
    contactId: z.string().min(5).max(80).optional(),
    contact: z
      .object({
        name: z.string().max(200).optional(),
        phone: z.string().min(7).max(25),
        organization: z.string().max(200).optional(),
      })
      .optional(),
    replyToMessageId,
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Boolean(value.contactId || value.contact), {
    message: 'Provide "contactId" or a "contact" object.',
    path: ['contactId'],
  });

export const sendPollBody = z.object({
  question: z.string().min(1).max(255),
  options: z.array(z.string().min(1).max(100)).min(2).max(12),
  allowMultipleAnswers: z.boolean().optional(),
  replyToMessageId,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const sendReactionBody = z.object({
  reaction: z.string().max(32),
});

export const boolFromQuery = (value) => value === 'true' || value === '1';

export { chatIdParams };
