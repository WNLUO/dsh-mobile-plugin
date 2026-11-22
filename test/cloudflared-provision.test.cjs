// CLOUDFLARED 镜像坏响应逐源隔离，首源与响应体超时不能吃掉后源预算。
'use strict';

/**
 * cloudflared 获取这一层的守卫：平台映射、已装优先（env / PATH）、缓存命中、下载+校验+解包、
 * 各种失败（校验不符 / 全源不通 / 平台不支持）。
 *
 * 这里不连真网：.tgz 在测试里现造，下载用注入的 fetch 假体，落盘用一次性临时目录。
 * 要保证的是「各种情况下都能给出一个明确结论」，而不是去验 cloudflare 官方那份二进制。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  CLOUDFLARED_VERSION,
  ASSETS,
  DEFAULT_BASE_URL,
  MIRROR_BASE_URLS,
  baseUrlsOf,
  fetchErrorMessage,
  platformId,
  findOnPath,
  resolveInstalled,
  extractTarGzEntry,
  ensureCloudflared,
} = require('../lib/cloudflared/provision.cjs');

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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-provision-'));
}

const noPath = { PATH: '' };

test('平台映射：认得出的才给 id，认不出返回 undefined', () => {
  assert.equal(platformId('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformId('darwin', 'x64'), 'darwin-x64');
  assert.equal(platformId('linux', 'x64'), 'linux-x64');
  assert.equal(platformId('linux', 'arm64'), 'linux-arm64');
  assert.equal(platformId('win32', 'x64'), 'win32-x64');
  // Windows on ARM 没有原生 cloudflared，归到 x64 资产（Windows 能跑 x64）。
  assert.equal(platformId('win32', 'arm64'), 'win32-x64');
  assert.equal(platformId('freebsd', 'x64'), undefined);
  assert.equal(platformId('linux', 'ia32'), undefined);
  assert.equal(platformId('linux', 'arm'), undefined);
});

test('资产表：四平台产物名、解包方式与真实 sha256 都填全', () => {
  assert.equal(CLOUDFLARED_VERSION, '2026.11.0');
  assert.deepEqual(Object.keys(ASSETS).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  assert.equal(ASSETS['darwin-x64'].file, 'cloudflared-darwin-amd64.tgz');
  assert.equal(ASSETS['darwin-arm64'].file, 'cloudflared-darwin-arm64.tgz');
  assert.equal(ASSETS['linux-x64'].file, 'cloudflared-linux-amd64');
  assert.equal(ASSETS['linux-arm64'].file, 'cloudflared-linux-arm64');
  assert.equal(ASSETS['win32-x64'].file, 'cloudflared-windows-amd64.exe');
  // macOS 两个是 .tgz，Linux/Windows 是裸二进制。
  assert.equal(ASSETS['darwin-x64'].archive, 'tar.gz');
  assert.equal(ASSETS['darwin-arm64'].archive, 'tar.gz');
  assert.equal(ASSETS['linux-x64'].archive, 'binary');
  assert.equal(ASSETS['linux-arm64'].archive, 'binary');
  assert.equal(ASSETS['win32-x64'].archive, 'binary');
  // 校验值必须是 64 位十六进制、且互不相同（占位/复制粘贴会在这里露馅）。
  const seen = new Set();
  for (const [id, asset] of Object.entries(ASSETS)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${id} 的 sha256 不是合法值`);
    assert.equal(seen.has(asset.sha256), false, `${id} 的 sha256 与别的平台重复`);
    seen.add(asset.sha256);
  }
});

test('findOnPath / resolveInstalled：env 显式路径最高优先', () => {
  const dir = tempDir();
  const bin = path.join(dir, 'my-cloudflared');
  fs.writeFileSync(bin, 'x');
  const r = resolveInstalled({ env: { DSHM_CLOUDFLARED_BIN: bin, PATH: '' }, platform: 'linux' });
  assert.deepEqual(r, { path: bin, source: 'env' });
});

test('findOnPath / resolveInstalled：PATH 里已有就认', () => {
  const dir = tempDir();
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, 'x');
  assert.equal(findOnPath('cloudflared', { env: { PATH: dir }, platform: 'linux' }), bin);
  assert.equal(findOnPath('cloudflared', { env: { PATH: '' }, platform: 'linux' }), null);
  const r = resolveInstalled({ env: { PATH: dir }, platform: 'linux' });
  assert.deepEqual(r, { path: bin, source: 'path' });
});

test('tar.gz 解包：挑出 cloudflared，不碰别的', () => {
  const archive = makeTarGz([
    { name: 'cloudflared', content: 'CLOUDFLARED-BIN' },
    { name: 'README.md', content: 'DOC' },
  ]);
  assert.equal(extractTarGzEntry(archive, 'cloudflared').toString('utf8'), 'CLOUDFLARED-BIN');
  assert.throws(() => extractTarGzEntry(archive, 'nope'), /没有找到/);
});

test('不支持平台：抛 unsupported-platform，不去下载', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('不该联网'); };
  await assert.rejects(
    () => ensureCloudflared({ platform: 'freebsd', arch: 'x64', env: noPath, cacheRoot: tempDir(), fetchImpl }),
    (error) => error.code === 'unsupported-platform',
  );
  assert.equal(called, 0);
});

test('自带命中（env）：最高优先，绝不联网', async () => {
  const dir = tempDir();
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, 'x');
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('不该联网'); };
  const r = await ensureCloudflared({ platformId: 'linux-x64', env: { DSHM_CLOUDFLARED_BIN: bin, PATH: '' }, cacheRoot: dir, fetchImpl });
  assert.equal(r.source, 'env');
  assert.equal(r.path, bin);
  assert.equal(called, 0);
});

test('PATH 命中：不联网，直接给路径', async () => {
  const dir = tempDir();
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, 'x');
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('不该联网'); };
  const r = await ensureCloudflared({ platformId: 'linux-x64', env: { PATH: dir }, cacheRoot: tempDir(), fetchImpl });
  assert.equal(r.source, 'path');
  assert.equal(r.path, bin);
  assert.equal(called, 0);
});

test('缓存命中：不联网，直接给路径', async () => {
  const root = tempDir();
  const cachedDir = path.join(root, CLOUDFLARED_VERSION, 'linux-x64');
  fs.mkdirSync(cachedDir, { recursive: true });
  const cached = path.join(cachedDir, 'cloudflared');
  fs.writeFileSync(cached, 'cached');
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('不该联网'); };
  const r = await ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, fetchImpl });
  assert.equal(r.source, 'cache');
  assert.equal(r.path, cached);
  assert.equal(r.version, CLOUDFLARED_VERSION);
  assert.equal(called, 0);
});

test('下载成功（.tgz）：校验 + 解包 + 落盘 + 可执行位', async () => {
  const root = tempDir();
  const archive = makeTarGz([{ name: 'cloudflared', content: 'FRESH-BIN' }]);
  const asset = { file: 'x.tgz', archive: 'tar.gz', bin: 'cloudflared', sha256: sha256(archive) };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive });
  const r = await ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl });
  assert.equal(r.source, 'download', JSON.stringify(r));
  assert.equal(r.version, CLOUDFLARED_VERSION);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'FRESH-BIN');
  assert.equal((fs.statSync(r.path).mode & 0o777).toString(8), '755', '应带上可执行位');
  // 第二次走缓存。
  const again = await ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, fetchImpl });
  assert.equal(again.source, 'cache');
});

test('下载成功（裸二进制，Linux/Windows 形态）：原样落盘', async () => {
  const root = tempDir();
  const raw = Buffer.from('RAW-BINARY-BYTES');
  const asset = { file: 'cloudflared-linux-amd64', archive: 'binary', bin: 'cloudflared', sha256: sha256(raw) };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => raw });
  const r = await ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl });
  assert.equal(r.source, 'download', JSON.stringify(r));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'RAW-BINARY-BYTES');
});

test('校验不符：抛 checksum，不留半装', async () => {
  const root = tempDir();
  const archive = makeTarGz([{ name: 'cloudflared', content: 'BIN' }]);
  const asset = { file: 'x.tgz', archive: 'tar.gz', bin: 'cloudflared', sha256: 'f'.repeat(64) };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => archive });
  await assert.rejects(
    () => ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, baseUrl: 'https://example.invalid/v', fetchImpl }),
    (error) => error.code === 'checksum',
  );
  assert.equal(fs.existsSync(path.join(root, CLOUDFLARED_VERSION, 'linux-x64', 'cloudflared')), false, '校验失败不该留下文件');
});

test('全源都不通：抛 download-failed，原因列出每条源的底层真话', async () => {
  const root = tempDir();
  const asset = { file: 'x.tgz', archive: 'tar.gz', bin: 'cloudflared', sha256: 'a'.repeat(64) };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw Object.assign(new Error('fetch failed'), { cause: new Error(`connect ENOTFOUND source-${calls}`) });
  };
  await assert.rejects(
    () => ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'download-failed');
      assert.equal(calls, baseUrlsOf().length, '每条源都要给一次机会');
      for (let i = 1; i <= calls; i += 1) assert.match(error.message, new RegExp(`ENOTFOUND source-${i}`));
      assert.doesNotMatch(error.message, /^下载 cloudflared 失败：fetch failed$/);
      return true;
    },
  );
});

test('下载源顺序：官方在前，镜像在后；显式钉死只试一条', () => {
  const bases = baseUrlsOf();
  assert.equal(bases[0], DEFAULT_BASE_URL);
  assert.deepEqual(bases.slice(1), MIRROR_BASE_URLS);
  assert.ok(MIRROR_BASE_URLS.length > 0, '得有镜像可退');
  for (const url of bases) assert.match(url, /^https:\/\//);
  assert.deepEqual(baseUrlsOf({ baseUrl: 'https://example.invalid/v' }), ['https://example.invalid/v']);
});

test('fetchErrorMessage：跳过表层的 fetch failed，挖出 cause 里的真话', () => {
  const buried = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('connect ETIMEDOUT 140.82.112.4:443'), { cause: new Error('whatever') }),
  });
  assert.equal(fetchErrorMessage(buried), 'connect ETIMEDOUT 140.82.112.4:443');
  assert.equal(fetchErrorMessage(new Error('HTTP 503')), 'HTTP 503');
  assert.equal(fetchErrorMessage(new Error('fetch failed')), 'fetch failed');
});

test('官方不通时自动换镜像：后源成功就落盘，且确实按序试过官方', async () => {
  const root = tempDir();
  const raw = Buffer.from('MIRROR-BIN');
  const asset = { file: 'cloudflared-linux-amd64', archive: 'binary', bin: 'cloudflared', sha256: sha256(raw) };
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (tried.length === 1) throw Object.assign(new Error('fetch failed'), { cause: new Error('connect ETIMEDOUT') });
    return { ok: true, status: 200, arrayBuffer: async () => raw };
  };
  const r = await ensureCloudflared({ platformId: 'linux-x64', env: noPath, cacheRoot: root, asset, fetchImpl });
  assert.equal(r.source, 'download', JSON.stringify(r));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'MIRROR-BIN');
  assert.equal(tried.length, 2, '第一条不通就该换第二条，不用试便停');
  assert.match(tried[0], /github\.com/);
  assert.equal(tried[1], `${MIRROR_BASE_URLS[0]}/cloudflared-linux-amd64`);
});
