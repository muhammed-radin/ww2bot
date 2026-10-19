/**
 * Health endpoints.
 *
 * /health/live  - is the process running?
 * /health/ready - are the configured dependencies reachable?
 *
 * Neither endpoint requires an API key, so neither may expose anything
 * sensitive: no environment variables, no phone numbers, no instance ids, no
 * connector state, no version of an internal component.
 */
import { Router } from 'express';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { ok } from '../utils/respond.js';

export function createHealthRouter({ config, store, connections }) {
  const router = Router();
  const startedAt = Date.now();

  router.get('/live', (_req, res) => {
    ok(res, {
      status: 'ok',
      service: config.serviceName,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  router.get('/ready', async (_req, res) => {
    const checks = {};
    let ready = true;

    // Storage is the only hard dependency: if data/ is not writable the service
    // cannot persist sessions and must not report itself ready.
    try {
      const probe = path.join(store.paths.tmpDir, `.health-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      await fs.writeFile(probe, 'ok', { mode: 0o600 });
      await fs.rm(probe, { force: true });
      checks.storage = { ok: true, mode: 'filesystem' };
    } catch {
      checks.storage = { ok: false, mode: 'filesystem' };
      ready = false;
    }

    checks.realtime = { ok: true, mode: 'in-process' };
    checks.browserInstances = connections?.browserManager ? connections.browserManager.size : 0;

    if (!ready) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'A required dependency is not ready.',
        },
        data: { status: 'unavailable', checks },
      });
    }

    return ok(res, { status: 'ready', checks });
  });

  return router;
}
