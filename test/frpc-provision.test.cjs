'use strict';

/**
 * frpc 获取这一层的守卫：平台映射、已装优先、缓存命中、下载+校验+解包、各种失败。
 *
 * 这里不连真网：tar.gz / zip 两种包都在测试里现造，下载用注入的 fetch 假体。要保证的是
 * 「各种情况下都能给出一个明确结论」，而不是去验 frp 官方那份二进制。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  FRP_VERSION,
  platformId,
  findOnPath,
  resolveInstalled,
  extractTarGzEntry,
  extractZipEntry,
  ensureFrpc,
  inspectFrpc,
} = require('../lib/frpc/provision.cjs');

/** 造一个 ustar 头。 */
function tarHeader(name, size, mode = 0o755, type = '0') {
  const buf = Buffer.alloc(512, 0);
  const oct = (off, len, value) => {
    const text = value.toString(8).padStart(len - 1, '0');
    buf.write(text, off, 'ascii');
    buf[off + len - 1] = 0;
  };
  buf.write(name, 0, 'utf8');
  oct(100, 8, mode);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, 0);
  buf.fill(0x20, 148, 156); // 校验和字段先按空格算
  buf.write(type, 156, 'ascii');
  buf.write('ustar', 257, 'ascii');
  buf[262] = 0;
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/** 造一个 .tar.gz。entries: [{ name, content }] */
function makeTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content, 'utf8');
    parts.push(tarHeader(entry.name, data.length));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** 造一个 store（不压缩）的 .zip。entries: [{ name, content }] */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // 存储方式
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localOffset = offset;
    locals.push(local, name, data);
    offset += 30 + name.length + data.length;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-provision-'));
}

const noPath = { PATH: '' };

test('平台映射：认得出的才给 id，认不出返回 undefined', () => {
  assert.equal(platformId('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformId('darwin', 'x64'), 'darwin-x64');
  assert.equal(platformId('linux', 'x64'), 'linux-x64');
  assert.equal(platformId('linux', 'arm64'), 'linux-arm64');
  assert.equal(platformId('win32', 'x64'), 'win32-x64');
  assert.equal(platformId('win32', 'arm64'), 'win32-arm64');
  assert.equal(platformId('freebsd', 'x64'), undefined);
  assert.equal(platformId('linux', 'ia32'), undefined);
  assert.equal(platformId('linux', 'arm'), undefined);
});

test('findOnPath / resolveInstalled：PATH 里已有就直接认', () => {
  const dir = tempDir();
  const bin = path.join(dir, 'frpc');
  fs.writeFileSync(bin, 'x');
  assert.equal(findOnPath('frpc', { env: { PATH: dir }, platform: 'linux' }), bin);
  assert.equal(findOnPath('frpc', { env: { PATH: '' }, platform: 'linux' }), null);
  const r = resolveInstalled({ env: { PATH: dir }, platform: 'linux' });
  assert.deepEqual(r, { path: bin, source: 'system' });
});

test('resolveInstalled：显式路径优先', () => {
  const dir = tempDir();
  const bin = path.join(dir, 'my-frpc');
  fs.writeFileSync(bin, 'x');
  const r = resolveInstalled({ env: { DSHM_FRPC_BIN: bin, PATH: '' }, platform: 'linux' });
  assert.deepEqual(r, { path: bin, source: 'configured' });
});

test('tar.gz 解包：挑出 frpc，不碰别的', () => {
  const archive = makeTarGz([
    { name: `frp_${FRP_VERSION}_linux_amd64/frps`, content: 'SERVER' },
    { name: `frp_${FRP_VERSION}_linux_amd64/frpc`, content: 'CLIENT-BIN' },
    { name: `frp_${FRP_VERSION}_linux_amd64/LICENSE`, content: 'L' },
  ]);
  assert.equal(extractTarGzEntry(archive, 'frpc').toString('utf8'), 'CLIENT-BIN');
  assert.throws(() => extractTarGzEntry(archive, 'nope'), /没有找到/);
});

test('zip 解包：挑出 frpc.exe', () => {
  const archive = makeZip([
    { name: `frp_${FRP_VERSION}_windows_amd64/frps.exe`, content: 'SERVER' },
    { name: `frp_${FRP_VERSION}_windows_amd64/frpc.exe`, content: 'WIN-BIN' },
  ]);
  assert.equal(extractZipEntry(archive, 'frpc.exe').toString('utf8'), 'WIN-BIN');
  assert.throws(() => extractZipEntry(archive, 'nope'), /没有找到/);
});

test('不支持平台：直接回不可用，不去下载', async () => {
  const r = await ensureFrpc({ platform: 'freebsd', arch: 'x64', env: noPath, cacheRoot: tempDir() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported-platform');
});

test('用户已装：最高优先，绝不联网', async () => {
  const dir = tempDir();
  const bin = path.join(dir, 'frpc');
  fs.writeFileSync(bin, 'x');
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('不该联网'); };
  const r = await ensureFrpc({ platformId: 'linux-x64', env: { DSHM_FRPC_BIN: bin, PATH: '' }, cacheRoot: dir, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'configured');
  assert.equal(called, 0);
});

test('缓存命中：不联网，直接给路径', async () => {
  const root = tempDir();
  const cachedDir = path.join(root, FRP_VERSION, 'linux-x64');
  fs.mkdirSync(cachedDir, { recursive: true });
  const cached = path.join(cachedDir, 'frpc');
  fs.writeFileSync(cached, 'cached');
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('不该联网'); };
  const r = await ensureFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'cache');
  assert.equal(r.path, cached);
  assert.equal(called, 0);
});

test('下载 + 校验 + 解包 + 落盘：拿到可执行文件', async () => {
  const root = tempDir();
  const archive = makeTarGz([{ name: `frp_${FRP_VERSION}_linux_amd64/frpc`, content: 'FRESH-BIN' }]);
  const asset = { file: 'x.tar.gz', archive: 'tar.gz', bin: 'frpc', sha256: sha256(archive) };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive });
  const r = await ensureFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.source, 'downloaded');
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'FRESH-BIN');
  // 第二次走缓存。
  const again = await ensureFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, fetchImpl });
  assert.equal(again.source, 'cache');
});

test('zip 也能下（Windows 形态）', async () => {
  const root = tempDir();
  const archive = makeZip([{ name: `frp_${FRP_VERSION}_windows_amd64/frpc.exe`, content: 'WIN-FRESH' }]);
  const asset = { file: 'x.zip', archive: 'zip', bin: 'frpc.exe', sha256: sha256(archive) };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive });
  const r = await ensureFrpc({ platformId: 'win32-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'WIN-FRESH');
});

test('校验不符：拒绝、不当成可用', async () => {
  const root = tempDir();
  const archive = makeTarGz([{ name: 'frp/frpc', content: 'BIN' }]);
  const asset = { file: 'x.tar.gz', archive: 'tar.gz', bin: 'frpc', sha256: 'f'.repeat(64) };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive });
  const r = await ensureFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'checksum');
  assert.equal(fs.existsSync(path.join(root, FRP_VERSION, 'linux-x64', 'frpc')), false, '校验失败不该留下文件');
});

test('下载失败：回明确原因，不留半装', async () => {
  const root = tempDir();
  const asset = { file: 'x.tar.gz', archive: 'tar.gz', bin: 'frpc', sha256: 'a'.repeat(64) };
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const r = await ensureFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'download-failed');
});

test('不允许联网又没缓存：回 offline', async () => {
  const r = await ensureFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: tempDir(), offline: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'offline');
});

test('并发触发只下一次', async () => {
  const root = tempDir();
  const archive = makeTarGz([{ name: 'frp/frpc', content: 'ONCE' }]);
  const asset = { file: 'x.tar.gz', archive: 'tar.gz', bin: 'frpc', sha256: sha256(archive) };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { ok: true, status: 200, arrayBuffer: async () => archive };
  };
  const options = { platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl };
  const [a, b] = await Promise.all([ensureFrpc(options), ensureFrpc(options)]);
  assert.equal(calls, 1, '同一平台同一时刻只该下载一次');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('inspect 不联网：报当前平台与可用性', () => {
  const root = tempDir();
  const before = inspectFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root });
  assert.equal(before.available, false);
  assert.equal(before.platform, 'linux-x64');
  const cachedDir = path.join(root, FRP_VERSION, 'linux-x64');
  fs.mkdirSync(cachedDir, { recursive: true });
  fs.writeFileSync(path.join(cachedDir, 'frpc'), 'x');
  const after = inspectFrpc({ platformId: 'linux-x64', env: noPath, cacheRoot: root });
  assert.equal(after.available, true);
  assert.equal(after.source, 'cache');
});
