import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { LOG_REDACT_PATHS } from '../../src/config/security.js';
import { redactForAudit } from '../../src/services/audit.service.js';
import { sanitiseUrl } from '../../src/utils/logger.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { BASE_TEST_ENV } from '../helpers/testApp.js';

function captureLogger() {
  const lines = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const config = loadConfig({ ...BASE_TEST_ENV, LOG_LEVEL: 'info' });
  const logger = createLogger(config, { destination });
  return { logger, lines, config };
}

test('logger redacts API keys, QR payloads and pairing codes', () => {
  const { logger, lines } = captureLogger();

  logger.info({ apiKey: 'wak_deadbeef00000000_secretsecret' }, 'key issued');
  logger.info({ qrDataUrl: 'data:image/png;base64,AAAA' }, 'qr delivered');
  logger.info({ pairingCode: 'ABCD1234' }, 'pairing code delivered');
  logger.info({ nested: { sessionData: 'browser-profile-bytes' } }, 'session stored');
  logger.info({ req: { headers: { 'x-api-key': 'wak_deadbeef00000000_secret' } } }, 'request');

  const output = lines.join('\n');
  assert.ok(!output.includes('secretsecret'));
  assert.ok(!output.includes('data:image/png'));
  assert.ok(!output.includes('ABCD1234'));
  assert.ok(!output.includes('browser-profile-bytes'));
  assert.ok(output.includes('[REDACTED]'));
  assert.ok(LOG_REDACT_PATHS.length > 5);
});

test('logger never silently drops the surrounding context', () => {
  const { logger, lines } = captureLogger();
  logger.info({ instanceId: 'ins_abc', eventType: 'auth.qr' }, 'connection event published');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.instanceId, 'ins_abc');
  assert.equal(parsed.eventType, 'auth.qr');
  assert.equal(parsed.msg, 'connection event published');
});

test('request URLs are logged without credential-bearing query values', () => {
  assert.equal(sanitiseUrl('/api/v1/instances?streamToken=abc123'), '/api/v1/instances?streamToken=%5BREDACTED%5D');
  assert.equal(sanitiseUrl('/api/v1/instances?token=abc123&limit=10'), '/api/v1/instances?token=%5BREDACTED%5D&limit=10');
  assert.equal(sanitiseUrl('/health/live'), '/health/live');
  assert.equal(sanitiseUrl(undefined), undefined);
});

test('audit metadata is redacted and truncated', () => {
  const redacted = redactForAudit({
    keyId: 'abc123',
    apiKey: 'wak_secret',
    pairingCode: 'ABCD1234',
    qr: 'payload',
    authorization: 'Bearer token',
    message: { text: 'private chat content' },
    body: 'private body',
    nested: { sessionData: 'blob', cookie: 'value' },
    long: 'x'.repeat(500),
    count: 3,
    ok: true,
    when: new Date('2026-01-01T00:00:00.000Z'),
    list: [1, 2, 3],
  });

  assert.equal(redacted.keyId, 'abc123');
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.pairingCode, '[REDACTED]');
  assert.equal(redacted.qr, '[REDACTED]');
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.message, '[REDACTED]');
  assert.equal(redacted.body, '[REDACTED]');
  assert.equal(redacted.nested.sessionData, '[REDACTED]');
  assert.equal(redacted.nested.cookie, '[REDACTED]');
  assert.equal(redacted.long.length, 200 + '[TRUNCATED]'.length);
  assert.equal(redacted.count, 3);
  assert.equal(redacted.ok, true);
  assert.equal(redacted.when, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(redacted.list, [1, 2, 3]);
  assert.equal(JSON.stringify(redacted).includes('private'), false);
});

test('audit redaction is depth limited', () => {
  let deep = { value: 'bottom' };
  for (let index = 0; index < 10; index += 1) deep = { nested: deep };
  assert.ok(JSON.stringify(redactForAudit(deep)).includes('[TRUNCATED]'));
});
