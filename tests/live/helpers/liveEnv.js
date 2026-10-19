/**
 * Opt-in helpers for live tests.
 *
 * The regular suite (`npm test`) never touches a real WhatsApp service: it uses
 * the in-memory repositories and the fake whatsapp-web.js module, so it runs in
 * CI with no credentials, no database and no browser.
 *
 * Live tests are for a human to run deliberately against a real deployment or
 * real Meta credentials:
 *
 *   WA_GATEWAY_LIVE_TESTS=1 npm run test:integration:live
 *
 * Every live test is skipped unless WA_GATEWAY_LIVE_TESTS=1 is set, and each
 * test additionally declares the environment variables it needs. A missing
 * variable produces a skip with an explicit reason — never a false pass.
 */

/** Master switch: without it every live test skips. */
export const liveEnabled = process.env.WA_GATEWAY_LIVE_TESTS === '1';

/**
 * Compute the skip condition for a live test.
 * @param {string[]} [requires] environment variables the test cannot run without
 * @returns {false|string} `false` when the test should run, otherwise the reason
 */
export function skipReason(requires = []) {
  if (!liveEnabled) return 'live tests are opt-in: set WA_GATEWAY_LIVE_TESTS=1';
  const missing = requires.filter((name) => !process.env[name]);
  if (missing.length > 0) return `missing environment: ${missing.join(', ')}`;
  return false;
}

/** Base URL of a running gateway, without a trailing slash. */
export function liveBaseUrl() {
  return (process.env.WA_GATEWAY_LIVE_BASE_URL ?? '').replace(/\/$/, '');
}

/** API key used to authenticate against the running gateway. */
export function liveApiKey() {
  return process.env.WA_GATEWAY_LIVE_API_KEY ?? '';
}

/** Small JSON fetch helper that never throws on non-2xx. */
export async function liveRequest(path, { method = 'GET', apiKey = liveApiKey(), body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (apiKey) requestHeaders['x-api-key'] = apiKey;
  let payload;
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${liveBaseUrl()}${path}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}
