/**
 * Automatic-reply rule management.
 *
 * Rules are configuration: reading them needs `data:read`; changing them is
 * owner-only (`auth:manage`), like the other instance lifecycle operations.
 */
import { Router } from 'express';
import { ROUTE_SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { autoReplyIdParams, createAutoReplyBody, instanceIdParams, updateAutoReplyBody } from '../validators/autoreply.validator.js';
import { created, ok } from '../utils/respond.js';

export function createAutoReplyRouter({ autoReplyService, requireScopes, rateLimit, loadInstance }) {
  const router = Router({ mergeParams: true });

  router.get(
    '/autoreplies',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: instanceIdParams }),
    loadInstance,
    async (req, res) => {
      const { items, limitations } = await autoReplyService.list(req.instance);
      return ok(res, { items, limitations }, { pagination: null });
    },
  );

  router.post(
    '/autoreplies',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: instanceIdParams, body: createAutoReplyBody }),
    loadInstance,
    async (req, res) => {
      const rule = await autoReplyService.create(req.instance, req.valid.body, {
        requestId: req.id,
        actorKeyId: req.auth?.keyId ?? null,
      });
      return created(res, { rule });
    },
  );

  router.get(
    '/autoreplies/:ruleId',
    rateLimit.read,
    requireScopes(...ROUTE_SCOPES.dataRead),
    validate({ params: autoReplyIdParams }),
    loadInstance,
    async (req, res) => {
      const rule = await autoReplyService.get(req.instance, req.valid.params.ruleId);
      return ok(res, { rule });
    },
  );

  router.patch(
    '/autoreplies/:ruleId',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: autoReplyIdParams, body: updateAutoReplyBody }),
    loadInstance,
    async (req, res) => {
      const rule = await autoReplyService.update(req.instance, req.valid.params.ruleId, req.valid.body, {
        requestId: req.id,
        actorKeyId: req.auth?.keyId ?? null,
      });
      return ok(res, { rule });
    },
  );

  router.delete(
    '/autoreplies/:ruleId',
    rateLimit.write,
    requireScopes(...ROUTE_SCOPES.authManage),
    validate({ params: autoReplyIdParams }),
    loadInstance,
    async (req, res) => {
      const result = await autoReplyService.remove(req.instance, req.valid.params.ruleId, {
        requestId: req.id,
        actorKeyId: req.auth?.keyId ?? null,
      });
      return ok(res, result);
    },
  );

  return router;
}
