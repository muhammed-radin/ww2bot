/**
 * API key administration.
 *
 * Guardrails:
 *  - creating a key for a different tenant is refused: a key can only ever
 *    manage keys inside its own tenant;
 *  - the plaintext secret is returned exactly once, in the 201 response;
 *  - listing never returns the digest, and rotation revokes the old key.
 */
import { Router } from 'express';
import { z } from 'zod';
import { SCOPES } from '../config/security.js';
import { validate } from '../middleware/validateRequest.js';
import { publicApiKeyView } from '../services/apiKey.service.js';
import { ForbiddenError } from '../utils/errors.js';
import { created, ok } from '../utils/respond.js';

const keyIdParams = z.object({ keyId: z.string().regex(/^[a-f0-9]{18}$/, 'must be a valid key id') });

const createKeyBody = z.object({
  name: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string()).min(1),
  tenantId: z.string().max(64).optional(),
  allowedInstanceIds: z.array(z.string().regex(/^ins_[a-f0-9]{32}$/)).min(1).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  ttlDays: z.number().int().min(1).max(3650).optional(),
});

const rotateBody = z.object({
  gracePeriodMs: z.number().int().min(0).max(86400000).optional(),
});

const listQuery = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

export function createApiKeysRouter({ apiKeyService, rateLimit }) {
  const router = Router();

  router.post(
    '/',
    rateLimit.admin,
    validate({ body: createKeyBody }),
    async (req, res) => {
      const { name, scopes, tenantId, allowedInstanceIds, expiresAt, ttlDays } = req.valid.body;
      if (tenantId && tenantId !== req.auth.tenantId) {
        throw new ForbiddenError('A key can only be created for its own tenant.', { field: 'tenantId' });
      }

      const { plaintext, record } = await apiKeyService.generate({
        tenantId: req.auth.tenantId,
        name,
        scopes,
        allowedInstanceIds: allowedInstanceIds ?? null,
        expiresAt: expiresAt ?? null,
        ttlDays,
        createdBy: req.auth.keyId,
        actorScopes: req.auth.scopes,
        requestId: req.id,
        ip: req.ip,
      });

      created(res, {
        // Shown once and never retrievable again.
        apiKey: plaintext,
        warning: 'Store this key securely now. It cannot be retrieved again.',
        key: publicApiKeyView(record),
      });
    },
  );

  router.get('/', rateLimit.read, validate({ query: listQuery }), async (req, res) => {
    const limit = Math.min(Number(req.valid.query.limit ?? 50), 200);
    const offset = Number(req.valid.query.offset ?? 0);
    const records = await apiKeyService.list(req.auth.tenantId, { limit, offset });
    ok(res, { items: records.map(publicApiKeyView), availableScopes: Object.values(SCOPES) });
  });

  router.get('/:keyId', rateLimit.read, validate({ params: keyIdParams }), async (req, res) => {
    const record = await apiKeyService.getOwn(req.auth, req.valid.params.keyId);
    ok(res, publicApiKeyView(record));
  });

  router.post(
    '/:keyId/rotate',
    rateLimit.admin,
    validate({ params: keyIdParams, body: rotateBody }),
    async (req, res) => {
      const { plaintext, record } = await apiKeyService.rotate(req.valid.params.keyId, {
        tenantId: req.auth.tenantId,
        requestId: req.id,
        actorKeyId: req.auth.keyId,
        actorScopes: req.auth.scopes,
        ip: req.ip,
        gracePeriodMs: req.valid.body?.gracePeriodMs ?? 0,
      });
      ok(res, {
        apiKey: plaintext,
        warning: 'Store this key securely now. The previous key has been revoked.',
        key: publicApiKeyView(record),
      });
    },
  );

  router.delete('/:keyId', rateLimit.admin, validate({ params: keyIdParams }), async (req, res) => {
    const result = await apiKeyService.revoke(req.valid.params.keyId, {
      tenantId: req.auth.tenantId,
      requestId: req.id,
      actorKeyId: req.auth.keyId,
      ip: req.ip,
    });
    ok(res, result);
  });

  return router;
}
