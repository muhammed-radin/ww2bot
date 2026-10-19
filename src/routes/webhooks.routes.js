/**
 * Meta webhook receiver for the official Cloud API connector.
 *
 * These routes are intentionally not API-key protected: Meta cannot send one.
 * They are instead protected by
 *  - the GET verification handshake (shared verify token, constant-time compare),
 *  - the X-Hub-Signature-256 HMAC over the raw request bytes (constant-time),
 *  - a per-IP rate limit,
 *  - the fact that only `messages` field changes are acted upon.
 *
 * Duplicate deliveries are de-duplicated by provider event id, so retries are
 * harmless.
 */
import { Router } from 'express';
import { UnauthorizedError } from '../utils/errors.js';
import { ok } from '../utils/respond.js';

export function createWebhooksRouter({ webhookService, rateLimit, logger }) {
  const router = Router();

  router.get('/whatsapp', (req, res) => {
    const result = webhookService.verifyChallenge({
      mode: req.query['hub.mode'],
      token: req.query['hub.verify_token'],
      challenge: req.query['hub.challenge'],
    });

    if (!result.ok) {
      logger?.warn({ reason: result.reason, requestId: req.id }, 'webhook verification handshake failed');
      return res.status(403).type('text/plain').send('Forbidden');
    }

    return res.status(200).type('text/plain').send(result.challenge);
  });

  router.post('/whatsapp', rateLimit.webhook, async (req, res) => {
    const signature = req.get('x-hub-signature-256');

    if (!req.rawBody) {
      throw new UnauthorizedError('The webhook request did not include a verifiable body.');
    }

    if (!webhookService.verifySignature(req.rawBody, signature)) {
      logger?.warn({ requestId: req.id, ip: req.ip }, 'webhook signature verification failed');
      throw new UnauthorizedError('The webhook signature is invalid.');
    }

    const summary = await webhookService.handleCloudPayload({
      payload: req.body,
      requestId: req.id,
    });

    // Meta only needs a fast 200.
    return ok(res, { accepted: true, ...summary });
  });

  return router;
}
