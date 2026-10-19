/**
 * Static hosting for the owner dashboard (ww2web).
 *
 * The dashboard is built by Vite with base `/frontend/` and published into
 * `<service>/public/frontend`. Express serves:
 *
 *   GET /ui        -> 308 redirect to /ui/
 *   GET /ui/       -> public/frontend/index.html   (the SPA shell)
 *   GET /frontend/* -> hashed JS/CSS/font assets
 *
 * The SPA uses a HashRouter, so every client route lives behind `#/` and the
 * server only ever needs to serve one HTML file. Nothing outside
 * `public/frontend` is reachable: `DATA_DIR`, sessions, `.env` and the source
 * tree are never exposed.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { uiHelmetOptions } from '../config/security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_DIR = path.resolve(here, '../../public/frontend');
export const FRONTEND_INDEX = path.join(FRONTEND_DIR, 'index.html');

const NOT_BUILT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ww2web is not available</title></head>
<body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size:1.25rem;">ww2web is not available</h1>
<p>The dashboard has not been built on this host.</p>
<p>Build it with <code>npm run build:frontend</code> and restart the service.</p>
</body></html>`;

/**
 * Mount the dashboard routes on the application. Safe to call even when the
 * frontend has not been built: `/ui/` then returns a clear 503 instead of a
 * stack trace.
 */
export function mountFrontend(app, { logger = null } = {}) {
  // Strict routing keeps `/ui` (redirect) and `/ui/` (the SPA shell) distinct —
  // Express otherwise treats a trailing slash as optional and redirects forever.
  const router = express.Router({ strict: true });

  // The dashboard needs a slightly wider CSP than the JSON API; this overrides
  // the `default-src 'none'` policy set for the API by helmet above it. The
  // policy still allows only same-origin resources.
  router.use(helmet(uiHelmetOptions()));

  router.get('/ui', (_req, res) => {
    res.redirect(308, '/ui/');
  });

  router.get('/ui/', async (req, res) => {
    try {
      await fs.access(FRONTEND_INDEX);
    } catch {
      logger?.warn({ indexPath: FRONTEND_INDEX }, 'dashboard requested but public/frontend/index.html is missing');
      return res.status(503).type('html').send(NOT_BUILT_HTML);
    }
    // The shell must never be cached: a new deploy must be picked up at once.
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(FRONTEND_INDEX);
  });

  // Hashed build assets. `fallthrough: true` lets us answer a missing asset with
  // a JSON 404 instead of leaking an Express error page.
  router.use(
    '/frontend',
    express.static(FRONTEND_DIR, {
      index: false,
      dotfiles: 'deny',
      fallthrough: true,
      etag: true,
      maxAge: '1h',
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );

  router.use('/frontend', (req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'The requested asset does not exist.' },
      requestId: req.id,
    });
  });

  app.use(router);
  return router;
}
