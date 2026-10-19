/**
 * Owner dashboard session security.
 *
 * Covers the browser sign-in flow added for ww2web: an owner API key is
 * exchanged for an HttpOnly session cookie, the RazorBills service key can
 * never sign in, cookie-authenticated state changes require a CSRF token, and
 * the API-key path is unaffected.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../helpers/testApp.js';

/** Pull the session cookie out of a response's Set-Cookie header. */
function sessionCookie(response, name = 'ww2_owner_session') {
  const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  for (const entry of raw) {
    if (entry && entry.startsWith(`${name}=`)) return entry.split(';')[0];
  }
  return null;
}

describe('owner dashboard sessions', () => {
  let app;
  let owner;
  let service;
  let tenantId;

  before(async () => {
    app = await startTestApp();
    tenantId = 'tenant-owner';
    owner = await app.issueKey({ tenantId, scopes: ['*'], name: 'owner' });
    service = await app.issueKey({ tenantId, scopes: ['messages:send'], name: 'razorbills' });
  });

  after(async () => {
    await app.close();
  });

  it('exchanges a valid owner key for an HttpOnly session cookie', async () => {
    const response = await app.request('/api/v1/ui/auth/login', {
      method: 'POST',
      body: { apiKey: owner.plaintext },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.ok(response.body.data.owner.keyId === owner.record.keyId);
    assert.ok(typeof response.body.data.csrfToken === 'string' && response.body.data.csrfToken.length >= 32);

    const setCookie = (response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']).join('\n');
    assert.match(setCookie, /ww2_owner_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);

    // The session cookie value is never echoed in the JSON body.
    const cookie = sessionCookie(response);
    assert.ok(cookie);
    assert.equal(response.text.includes(cookie.split('=')[1]), false);
  });

  it('rejects the service key with a friendly forbidden response', async () => {
    const response = await app.request('/api/v1/ui/auth/login', {
      method: 'POST',
      body: { apiKey: service.plaintext },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'FORBIDDEN');
    assert.equal(sessionCookie(response), null);
  });

  it('rejects an invalid key without leaking why', async () => {
    const response = await app.request('/api/v1/ui/auth/login', {
      method: 'POST',
      body: { apiKey: 'wak_0123456789abcdef01_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
  });

  it('reports the current session and 401s without one', async () => {
    const anonymous = await app.request('/api/v1/ui/auth/session');
    assert.equal(anonymous.status, 401);

    const login = await app.request('/api/v1/ui/auth/login', { method: 'POST', body: { apiKey: owner.plaintext } });
    const cookie = sessionCookie(login);

    const session = await app.request('/api/v1/ui/auth/session', { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.body.data.owner.keyId, owner.record.keyId);
    assert.ok(session.body.data.csrfToken);
  });

  it('requires a CSRF token for cookie-authenticated state changes', async () => {
    const login = await app.request('/api/v1/ui/auth/login', { method: 'POST', body: { apiKey: owner.plaintext } });
    const cookie = sessionCookie(login);
    const csrfToken = login.body.data.csrfToken;

    const withoutCsrf = await app.request('/api/v1/instances', {
      method: 'POST',
      headers: { cookie },
      body: { connector: 'cloud_api', displayName: 'no-csrf' },
    });
    assert.equal(withoutCsrf.status, 403);
    assert.equal(withoutCsrf.body.error.code, 'CSRF_REQUIRED');

    const withCsrf = await app.request('/api/v1/instances', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrfToken },
      body: { connector: 'cloud_api', displayName: 'with-csrf' },
    });
    assert.equal(withCsrf.status, 201);
    assert.equal(withCsrf.body.data.instance.displayName, 'with-csrf');
  });

  it('allows safe reads with the cookie and no CSRF token', async () => {
    const login = await app.request('/api/v1/ui/auth/login', { method: 'POST', body: { apiKey: owner.plaintext } });
    const cookie = sessionCookie(login);

    const instances = await app.request('/api/v1/instances', { headers: { cookie } });
    assert.equal(instances.status, 200);
    assert.ok(Array.isArray(instances.body.data.items));

    const overview = await app.request('/api/v1/ui/overview', { headers: { cookie } });
    assert.equal(overview.status, 200);
    assert.ok(overview.body.data.connections.total >= 0);
  });

  it('revokes the session on logout', async () => {
    const login = await app.request('/api/v1/ui/auth/login', { method: 'POST', body: { apiKey: owner.plaintext } });
    const cookie = sessionCookie(login);
    const csrfToken = login.body.data.csrfToken;

    const logout = await app.request('/api/v1/ui/auth/logout', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.data.revoked, true);

    const after = await app.request('/api/v1/ui/auth/session', { headers: { cookie } });
    assert.equal(after.status, 401);
  });

  it('keeps owner-only views out of reach of the service key', async () => {
    for (const path of ['/api/v1/ui/config', '/api/v1/ui/overview', '/api/v1/ui/deliveries', '/api/v1/ui/audit-events']) {
      const response = await app.request(path, { apiKey: service.plaintext });
      assert.equal(response.status, 403, `${path} should be forbidden for the service key`);
    }
  });

  it('never exposes secrets in the configuration view', async () => {
    const response = await app.request('/api/v1/ui/config', { apiKey: owner.plaintext });
    assert.equal(response.status, 200);
    const serialised = JSON.stringify(response.body.data);

    // The real secret values must never appear, whatever their field name.
    assert.equal(serialised.includes(app.config.security.apiKeyPepper), false);
    assert.equal(serialised.includes(app.config.encryption.keys[app.config.encryption.activeKeyId]), false);
    assert.equal(serialised.includes(app.dataDir), false);

    // Sensitive settings are reported as configured/not configured instead.
    assert.equal(typeof response.body.data.connectors.cloud.accessToken, 'string');
    assert.equal(typeof response.body.data.security.apiKeyPepper, 'string');
    assert.equal(response.body.data.storage.dataDirConfigured, true);
  });

  it('still authenticates the normal API with an API key (no CSRF needed)', async () => {
    const created = await app.request('/api/v1/instances', {
      method: 'POST',
      apiKey: owner.plaintext,
      body: { connector: 'cloud_api', displayName: 'api-key-instance' },
    });
    assert.equal(created.status, 201);

    const listed = await app.request('/api/v1/instances', { apiKey: owner.plaintext });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.items.some((item) => item.displayName === 'api-key-instance'));
  });

  it('serves the dashboard shell redirect and 404s missing assets', async () => {
    const redirect = await fetch(`${app.baseUrl}/ui`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/ui/');

    const missing = await app.request('/frontend/does-not-exist.js');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  });
});
