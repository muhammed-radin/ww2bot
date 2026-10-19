/**
 * Optional source-IP allowlist.
 *
 * When `IP_ALLOWLIST` is configured, requests from outside the list are rejected
 * before any parsing or authentication. Entries are exact IPv4/IPv6 addresses or
 * IPv4 CIDR ranges. IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are treated as
 * their IPv4 form so a proxied request matches the same entries as a direct one.
 */
import { ForbiddenError } from '../utils/errors.js';

function normaliseIp(ip) {
  if (typeof ip !== 'string') return '';
  // Strip an IPv6 zone id, then unwrap IPv4-mapped IPv6.
  const withoutZone = ip.split('%')[0];
  const mapped = withoutZone.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return (mapped ? mapped[1] : withoutZone).toLowerCase();
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function matchesEntry(ip, entry) {
  if (entry.includes('/')) {
    const [network, prefixRaw] = entry.split('/');
    const prefix = Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const networkInt = ipv4ToInt(network);
    const ipInt = ipv4ToInt(ip);
    if (networkInt === null || ipInt === null) return false;
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (networkInt & mask);
  }
  return ip === entry;
}

export function createIpAllowlist({ allowlist, logger = null }) {
  const entries = allowlist.map((entry) => entry.toLowerCase());
  return function ipAllowlistMiddleware(req, res, next) {
    const ip = normaliseIp(req.ip);
    if (entries.some((entry) => matchesEntry(ip, entry))) return next();
    logger?.warn({ ip }, 'rejected a request from an IP outside the allowlist');
    return next(new ForbiddenError('Requests from this IP address are not allowed.', { code: 'IP_NOT_ALLOWED' }));
  };
}
