/**
 * Static hosting for the owner dashboard.
 *
 * These assertions are deliberately tolerant of whether the dashboard has been
 * published on this host (`npm run build:frontend`): routing, security headers
 * and the not-built fallback must all be correct either way.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../helpers/testApp.js';

describe('dashboard static hosting', () => {
  let app;

  before(async () => {
    app = await startTestApp();
  });

  after(async () => {
    await app.close();
  });

  it('redirects /ui to /ui/ exactly once', async () => {
    const response = await fetch(`${app.baseUrl}/ui`, { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), '/ui/');
  });

  it('serves the SPA shell at /ui/ or a clear 503 when it was never built', async () => {
    const response = await fetch(`${app.baseUrl}/ui/`);
    assert.ok([200, 503].includes(response.status), `unexpected status ${response.status}`);

    const html = await response.text();
    if (response.status === 200) {
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(html, /<div id="root">/);
      // Assets must resolve under /frontend/, not at the site root.
      assert.match(html, /\/frontend\/assets\//);
      // The shell must never be cached, so a redeploy is picked up immediately.
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } else {
      assert.match(html, /npm run build:frontend/);
    }
  });

  it('applies a same-origin dashboard CSP to /ui/', async () => {
    const response = await fetch(`${app.baseUrl}/ui/`);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    // Inline script is never allowed; the SPA is a bundled external module.
    assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false);
    assert.equal(/script-src[^;]*unsafe-eval/.test(csp), false);
  });

  it('answers a missing asset with a JSON 404 instead of an error page', async () => {
    const response = await fetch(`${app.baseUrl}/frontend/does-not-exist.js`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('never serves the directory listing or dotfiles', async () => {
    const listing = await fetch(`${app.baseUrl}/frontend/`);
    assert.equal(listing.status, 404);
    const dotfile = await fetch(`${app.baseUrl}/frontend/.env`);
    assert.equal(dotfile.status, 404);
  });

  it('leaves the JSON API routes untouched', async () => {
    const response = await fetch(`${app.baseUrl}/api/v1/ui/overview`);
    // Unauthenticated: the protected middleware still owns this path.
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
  });
});
