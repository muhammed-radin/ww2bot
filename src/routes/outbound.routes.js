/**
 * Outbound messaging endpoint used by the RazorBills backend.
 *
 * `POST /api/v1/messages/send` requires only the narrow `messages:send` scope,
 * so the integration key can send messages without any ability to manage
 * authentication, credentials or instances.
 *
 * The instance is named in the body and loaded through the tenant-isolating
 * service, so a key can only ever address instances it is entitled to.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ROUTE_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { ok } from '../utils/respond.js';

const sendBody = z.object({
  instanceId: z.string().regex(/^ins_[a-f0-9]{32}$/, 'must be a valid instance id'),
  to: z.string().min(5).max(80),
  type: z.literal('text').optional(),
  text: z.string().min(1).max(4096),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export function createOutboundRouter({ outboundService, instanceService, requireScopes, rateLimit }) {
  const router = Router();

  router.post(
    '/send',
    rateLimit.send,
    requireScopes(...ROUTE_SCOPES.messagesSend),
    validate({ body: sendBody }),
    async (req, res) => {
      const body = req.valid.body;
      const instance = await instanceService.getOwned(req.auth, body.instanceId);

      const idempotencyKey = req.get('idempotency-key') ?? body.idempotencyKey ?? null;
      const result = await outboundService.send(instance, req.auth, {
        to: body.to,
        text: body.text,
        type: body.type,
        idempotencyKey,
        requestId: req.id,
        ip: req.ip,
      });
      ok(res, result);
    },
  );

  return router;
}
