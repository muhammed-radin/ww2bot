import test from 'node:test';
import assert from 'node:assert/strict';
import { EncryptionService } from '../../src/services/encryption.service.js';

const KEY_K1 = Buffer.alloc(32, 1).toString('base64');
const KEY_K2 = Buffer.alloc(32, 2).toString('base64');

function service({ active = 'k1', keys = { k1: KEY_K1 } } = {}) {
  return new EncryptionService({ keys, activeKeyId: active });
}

test('encrypt/decrypt round trip for strings and buffers', () => {
  const encryption = service();
  const token = encryption.encrypt('session material');
  assert.match(token, /^ENC:v1:k1:/);

  assert.equal(encryption.decrypt(token), 'session material');
  const binary = Buffer.from([0, 1, 2, 250, 251, 252]);
  assert.deepEqual(encryption.decryptBuffer(encryption.encrypt(binary)), binary);
});

test('ciphertext is unique per call (random IV) and never contains the plaintext', () => {
  const encryption = service();
  const a = encryption.encrypt('same plaintext');
  const b = encryption.encrypt('same plaintext');
  assert.notEqual(a, b);
  assert.ok(!a.includes(Buffer.from('same plaintext').toString('base64url')));
});

test('additional authenticated data binds a ciphertext to its location', () => {
  const encryption = service();
  const token = encryption.encrypt('bound value', { aad: 'session:ins_a' });
  assert.equal(encryption.decrypt(token, { aad: 'session:ins_a' }), 'bound value');
  assert.throws(() => encryption.decrypt(token, { aad: 'session:ins_b' }), /integrity check/);
  assert.throws(() => encryption.decrypt(token), /integrity check/);
});

test('tampered ciphertext fails the integrity check', () => {
  const encryption = service();
  const token = encryption.encrypt('do not modify');
  const parts = token.split(':');
  const flipped = Buffer.from(parts[5], 'base64url');
  flipped[0] ^= 0xff;
  const tampered = [...parts.slice(0, 5), flipped.toString('base64url')].join(':');
  assert.throws(() => encryption.decrypt(tampered), /integrity check/);

  const tagTampered = [...parts.slice(0, 4), Buffer.alloc(16, 9).toString('base64url'), parts[5]].join(':');
  assert.throws(() => encryption.decrypt(tagTampered), /integrity check/);
});

test('a ciphertext from an unknown key cannot be decrypted', () => {
  const original = service();
  const token = original.encrypt('secret');
  const other = service({ keys: { k9: KEY_K2 }, active: 'k9' });
  assert.throws(() => other.decrypt(token), /unknown encryption key/);
});

test('key rotation rewraps existing ciphertext with the active key', () => {
  const before = service();
  const token = before.encrypt('rotate me');

  const after = new EncryptionService({ keys: { k1: KEY_K1, k2: KEY_K2 }, activeKeyId: 'k2' });
  assert.equal(after.isCurrentKey(token), false);
  const rewrapped = after.rewrap(token);
  assert.equal(after.isCurrentKey(rewrapped), true);
  assert.equal(after.decrypt(rewrapped), 'rotate me');
  // The old key remains usable, so rotation is not destructive.
  assert.equal(after.decrypt(token), 'rotate me');
});

test('keyed digests are deterministic, purpose-separated and not reversible', () => {
  const encryption = service();
  const first = encryption.keyedDigest('provider-event-id');
  assert.equal(first, encryption.keyedDigest('provider-event-id'));
  assert.notEqual(first, encryption.keyedDigest('provider-event-id', { purpose: 'other' }));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.ok(!first.includes('provider'));
});

test('construction rejects invalid key material', () => {
  assert.throws(() => new EncryptionService({ keys: {}, activeKeyId: 'k1' }), /No encryption keys/);
  assert.throws(
    () => new EncryptionService({ keys: { k1: KEY_K1 }, activeKeyId: 'nope' }),
    /active encryption key id/,
  );
  assert.throws(
    () => new EncryptionService({ keys: { 'bad:id': KEY_K1 }, activeKeyId: 'bad:id' }),
    /may only contain letters/,
  );
  assert.throws(
    () => new EncryptionService({ keys: { k1: Buffer.alloc(8, 1).toString('base64') }, activeKeyId: 'k1' }),
    /exactly 32 bytes/,
  );
});

test('decrypt rejects malformed input without throwing internals', () => {
  const encryption = service();
  assert.throws(() => encryption.decrypt(''), /empty value/);
  assert.throws(() => encryption.decrypt('not-a-token'), /malformed/);
  assert.throws(() => encryption.decrypt('ENC:v9:k1:aa:bb:cc'), /version is not supported/);
  assert.throws(() => encryption.decrypt('ENC:v1:k1:aaaa:bbbb:cccc'), /malformed/);
});
