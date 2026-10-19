# Live tests

These tests talk to **real** services: a deployed gateway, the real Meta Graph
API, or a real Chromium browser. They are **opt-in** and never run as part of
`npm test`, so CI stays hermetic and needs no credentials.

Everything here is skipped unless you set the master switch:

```bash
WA_GATEWAY_LIVE_TESTS=1 npm run test:integration:live
```

Each test also declares the variables it needs; a missing variable turns into a
**skip with an explicit reason**, never a false pass.

## Files

| File | What it checks | Extra switch / environment |
| --- | --- | --- |
| `gateway.live.test.js` | Health, connector discovery and instance listing on a running gateway (read-only) | `WA_GATEWAY_LIVE_BASE_URL`, `WA_GATEWAY_LIVE_API_KEY` |
| `cloudApi.live.test.js` | The configured Cloud API credentials resolve the business phone number (read-only Graph API call) | `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID` (optional `META_API_VERSION`, `META_GRAPH_BASE_URL`) |
| `webAuth.live.test.js` | A real Chromium launches through whatsapp-web.js and WhatsApp returns a QR challenge | `WA_GATEWAY_LIVE_WEB=1` and the optional deps installed |

## Running them

### Smoke-test a deployment

```bash
WA_GATEWAY_LIVE_TESTS=1 \
WA_GATEWAY_LIVE_BASE_URL=https://gateway.example.com \
WA_GATEWAY_LIVE_API_KEY=wak_... \
node --test "tests/live/gateway.live.test.js"
```

The key only needs `instances:read`; the test never creates or mutates anything.

### Verify Cloud API credentials after a rotation

```bash
WA_GATEWAY_LIVE_TESTS=1 \
META_ACCESS_TOKEN=EAAG... \
META_PHONE_NUMBER_ID=106540352242922 \
node --test "tests/live/cloudApi.live.test.js"
```

### Exercise the browser flow

```bash
npm run setup:web-connector            # once: installs whatsapp-web.js + puppeteer
WA_GATEWAY_LIVE_TESTS=1 WA_GATEWAY_LIVE_WEB=1 \
node --test "tests/live/webAuth.live.test.js"
```

The browser test requests a QR challenge but **does not scan it**, so no device
is linked.

## Safety notes

- Live tests are read-only unless a test's name says otherwise.
- Never commit live credentials. Pass them through your shell or secret manager.
- The WhatsApp Web connector requires the written authorization recorded in
  `WHATSAPP_WEB_AUTHORIZATION_REFERENCE` for your exact use case; see the main
  `README.md`.
