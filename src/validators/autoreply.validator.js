/**
 * Validation schemas for automatic-reply rules.
 */
import { z } from 'zod';
import { instanceIdParams } from '../middleware/validateRequest.js';

const matchSchema = z.object({
  type: z.enum(['exact', 'contains', 'prefix', 'regex']),
  value: z.string().min(1).max(500),
  caseSensitive: z.boolean().optional(),
});

const replySchema = z.object({
  text: z.string().min(1).max(4096),
});

export const createAutoReplyBody = z.object({
  name: z.string().min(1).max(80).nullable().optional(),
  enabled: z.boolean().optional(),
  match: matchSchema,
  reply: replySchema,
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
});

export const updateAutoReplyBody = z
  .object({
    name: z.string().min(1).max(80).nullable().optional(),
    enabled: z.boolean().optional(),
    match: matchSchema.partial().optional(),
    reply: replySchema.partial().optional(),
    cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update.' });

export const autoReplyIdParams = instanceIdParams.extend({
  ruleId: z.string().regex(/^arr_[a-f0-9]{24}$/, 'must be a valid rule id'),
});

export { instanceIdParams };
