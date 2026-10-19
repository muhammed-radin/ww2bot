/**
 * Validation schemas for instance, connection and session routes.
 */
import { z } from 'zod';
import { instanceIdParams, paginationQuery } from '../middleware/validateRequest.js';

export const createInstanceBody = z.object({
  connector: z.enum(['cloud_api', 'web']).optional(),
  displayName: z.string().min(1).max(80).optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
  retentionEnabled: z.boolean().optional(),
  metadata: z
    .object({
      phoneNumberId: z.union([z.string().regex(/^\d{5,32}$/), z.null()]).optional(),
      label: z.string().max(64).nullable().optional(),
      authorizationReference: z.string().max(128).nullable().optional(),
    })
    .strict()
    .optional(),
});

export const listInstancesQuery = paginationQuery;

export const pairingCodeBody = z.object({
  phoneNumber: z
    .string()
    .min(8)
    .max(20)
    // International format, digits only (no +, spaces or dashes).
    .regex(/^[1-9]\d{7,19}$/, 'must be an international phone number with digits only, e.g. 919812345678'),
  force: z.boolean().optional(),
});

export const connectQrBody = z
  .object({
    force: z.boolean().optional(),
  })
  .optional();

export const streamTokenBody = z.object({}).optional();

export const retentionBody = z.object({
  retentionEnabled: z.boolean().optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
});

export const auditQuery = paginationQuery.extend({
  action: z.string().max(64).optional(),
});

export { instanceIdParams };
