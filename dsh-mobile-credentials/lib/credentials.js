'use strict';

/** Persistent per-device relay credentials. The bearer secret is returned once;
 * only its hash is stored on disk. The host token is retained so a durable
 * relay credential can continue to authenticate legacy 30-day clients. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FILE = process.env.DEVICE_CREDENTIALS_FILE || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'relay-device-credentials.json');
/** Default credential lifetime. `issue(..., ttlMs)` may override; `ttlMs <= 0` opts out. */
const DEFAULT_TTL_MS = 365 * 24 * 3600 * 1000;
let loaded = false;
let records = [];
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
/** Constant-time hash comparison (both sides are 64-char hex). */
function hashEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
function load() {
  if (loaded) return;
  loaded = true;
  try { const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); records = Array.isArray(data) ? data : []; } catch { records = []; }
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function issue(instanceId, device, hostToken, ttlMs = DEFAULT_TTL_MS) {
  load();
  const deviceId = String(device?.deviceId || device?.id || crypto.randomUUID()).slice(0, 128);
  const credential = `dshc_${crypto.randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  // A host instance may be paired with multiple phone installations.
  // deviceId is client metadata and can collide after app-data migration or
  // cloning, so it must not be used as a uniqueness constraint for credentials.
  const record = { instanceId, deviceId, hash: digest(credential), hostToken: typeof hostToken === 'string' ? hostToken : '', createdAt: now };
  // `find()` has always honoured `expiresAt`, but nothing ever set it — so every
  // credential was permanent and "revoke" only marked records that the cookie
  // path never consulted. Issue an explicit expiry by default.
  if (Number.isFinite(ttlMs) && ttlMs > 0) record.expiresAt = now + ttlMs;
  records.push(record);
  save();
  return { credential, deviceId, expiresAt: record.expiresAt || null };
}
function find(credential, instanceId) {
  load();
  if (typeof credential !== 'string' || !credential) return null;
  const hash = digest(credential);
  const now = Date.now();
  let match = null;
  // Scan every record: an early-exit `Array.find` would leak the matching
  // position through response timing.
  for (const record of records) {
    const same = hashEquals(record.hash, hash);
    if (same && record.instanceId === instanceId && isLive(record, now)) match = record;
  }
  return match;
}
/**
 * Look up a credential this store issued, whether or not it is still live.
 *
 * `find()` answers "may this caller proceed?". This answers "did we ever issue
 * this here?" — and the difference is load-bearing. The desktop host and the
 * Relay keep separate credential stores, so a phone paired over the public
 * Relay presents a `dshc_` the host has never seen. That one must fall back to
 * its stateless token instead of being rejected. A `dshc_` the host *did* issue
 * must instead be authoritative, so that revoking it takes effect immediately.
 */
function lookup(credential, instanceId) {
  load();
  if (typeof credential !== 'string' || !credential) return null;
  const hash = digest(credential);
  let match = null;
  for (const record of records) {
    const same = hashEquals(record.hash, hash);
    if (same && record.instanceId === instanceId) match = record;
  }
  return match;
}
/** True when a record is neither revoked nor past its expiry. */
function isLive(record, now = Date.now()) {
  return Boolean(record) && !record.revokedAt && (!record.expiresAt || record.expiresAt > now);
}
/**
 * Look up the newest live credential issued to a device.
 *
 * Pairing cookies carry a deviceId instead of the bearer secret, so this is the
 * only way for the Relay to notice that a device was revoked (or that its
 * credential expired) without the phone having to present the secret itself.
 */
function isActiveDevice(instanceId, deviceId) {
  load();
  if (typeof deviceId !== 'string' || !deviceId) return null;
  const now = Date.now();
  let match = null;
  for (const record of records) {
    if (record.instanceId === instanceId && record.deviceId === deviceId && isLive(record, now)) match = record;
  }
  return match;
}
function revoke(credential, instanceId) {
  load();
  const record = find(credential, instanceId);
  if (!record) return false;
  record.revokedAt = Date.now();
  save();
  return true;
}
function listActive() {
  load();
  return records.filter((record) => !record.revokedAt && (!record.expiresAt || record.expiresAt > Date.now())).map(({ instanceId, deviceId, createdAt, expiresAt }) => ({ instanceId, deviceId, createdAt, ...(expiresAt ? { expiresAt } : {}) }));
}
function revokeDevice(instanceId, deviceId) {
  load();
  let count = 0;
  for (const record of records) if (record.instanceId === instanceId && record.deviceId === deviceId && !record.revokedAt) { record.revokedAt = Date.now(); count += 1; }
  if (count) save();
  return count;
}
/** Revoke every live credential issued to a host instance (clear-all-authorization). */
function revokeAllByInstance(instanceId) {
  load();
  let count = 0;
  for (const record of records) if (record.instanceId === instanceId && !record.revokedAt) { record.revokedAt = Date.now(); count += 1; }
  if (count) save();
  return count;
}
module.exports = { FILE, DEFAULT_TTL_MS, issue, find, lookup, isLive, isActiveDevice, revoke, revokeDevice, revokeAllByInstance, listActive };
