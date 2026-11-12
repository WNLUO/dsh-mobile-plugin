'use strict';

/**
 * 「这次的产出」电脑侧两条路由的契约：批量 stat 与打包 zip。
 *
 * 这条的头号边界不是功能而是**放行面**：手机上能 stat / 打包的路径必须与本来就能下载的
 * 完全重合。所以这里钉的第一件事是「工作区外没声明过的路径是 denied、声明过的是 ok」，
 * 并顺带确认它调的是 `/session/file` 那份判定（同一个作用域对象，不是抄的一份）。
 *
 * 第二件事是打包的几个容易写错的形状：条目名只取 basename（zip 里不该出现 `../`）、同名
 * 按 `a.txt` / `a (2).txt` 去重、缺失那条只跳过、一条不剩才 404、超 512MB 是 413、临时 zip
 * 在成功与失败两条路上都删掉。zip 本身用本文件里那个极小的解包器读回来，不信「字节数看着对」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const artifacts = require('../lib/mobile/session-artifacts.js');
const { FILE_CHUNK_BYTES } = require('../lib/mobile/session-file.js');
const e2ee = require('../lib/shared/e2ee.js');

const BASE = '/api/mobile/v1/session';

/** 一条会话的上下行密钥（加密那一档只用 `down`）。 */
const TEST_KEYS = e2ee.deriveSessionKeys(Buffer.alloc(32, 0x22));

/** 一条交付声明事件（形状与宿主 dsh-tool-present 追加的那条一致）。 */
function presented(turn, paths) {
  return {
    type: 'deliverables/presented',
    data: { turn, files: paths.map((item) => (typeof item === 'string' ? { path: item } : item)) },
  };
}

/**
 * 起一个只挂这两条路由的服务；宿主 sessions.* 是假对象。
 *
 * @param {object} [options]
 * @param {string} [options.cwd] 会话工作区（相对路径的解析基准）
 * @param {object[]} [options.events] 历史事件
 * @param {object} [options.historyError] history 回错误时的 error 对象
 * @param {string} [options.e2eeNonce] 给这一档挂信封（模拟 v2 会话）
 */
async function serve(options = {}) {
  const calls = { history: 0, list: 0 };
  const ctx = {
    apiProxy: {
      sessions: {
        history: async () => {
          calls.history += 1;
          if (options.historyError) return { result: { ok: false, error: options.historyError } };
          return { result: { ok: true, value: { events: options.events || [] } } };
        },
        list: async () => {
          calls.list += 1;
          return { result: { ok: true, value: { items: [{ sessionId: 's1', cwd: options.cwd ?? null }] } } };
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    if (options.e2eeNonce) {
      req.__dshE2ee = { keys: TEST_KEYS, req: { ts: 1, nonce: options.e2eeNonce } };
    }
    const handler = req.url.startsWith(`${BASE}/archive`)
      ? artifacts.handleSessionArchive
      : artifacts.handleSessionArtifacts;
    Promise.resolve(handler(ctx, req, res)).catch((error) => {
      if (res.headersSent) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (pathname, body) => {
    const response = await fetch(`${origin}${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const headers = {
      length: response.headers.get('content-length'),
      disposition: response.headers.get('content-disposition'),
      fileSize: response.headers.get('x-dsh-file-size'),
      proto: response.headers.get('x-dsh-proto'),
      innerType: response.headers.get('x-dsh-content-type'),
    };
    if (type.startsWith('application/json')) {
      return { status: response.status, body: await response.json(), type, headers };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, type, headers };
  };
  return {
    calls,
    artifacts: (body) => post('/artifacts', body),
    archive: (body) => post('/archive', body),
    close: () => new Promise((resolve) => {
      // fetch 的 keep-alive 连接会让 close 干等：先断空闲连接再收服务器。
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function withHost(options, run) {
  const host = await serve(options);
  try {
    await run(host);
  } finally {
    await host.close();
  }
}

/** 建一个临时工作区，返回目录（用后自动删）。 */
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artifacts-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/**
 * 一个只够用的小 zip 解包器：读 EOCD → central directory → 逐条 inflate。
 *
 * 不引依赖（仓库硬约束），也不「看字节数大概对」就算过：条目名、原始内容、crc 都要能读回来。
 */
function unzip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  assert.notEqual(eocd, -1, '不是一份 zip：找不到 EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory 的签名不对');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'local header 的签名不对');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    const content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    // 中央目录里的 crc 必须与内容对得上：真解压器按它判「这份没坏」。
    assert.equal(crc, zlib.crc32(content), `${name} 的 crc 与内容不符`);
    assert.equal(size, content.length);
    entries.push({ name, content, size, crc });
  }
  return entries;
}

/** os.tmpdir() 里当前还挂着的临时 zip（测试按前缀认自己的）。 */
async function leftoverTmpZips() {
  const names = await fs.readdir(os.tmpdir());
  return names.filter((name) => name.startsWith(artifacts.ARCHIVE_TMP_PREFIX));
}

/**
 * 等临时 zip 回到基线。
 *
 * 服务端是在把响应发完之后才删临时文件的（`finally` 里那一下），客户端拿到响应不代表那一下
 * 已经跑完：Linux 的 runner 上这两件事挨得很近，读目录会读到刚建好还没删的那个。本地读得快
 * 就永远撞不上，所以「删干净」这件事必须等，不能一拍定胜负。
 */
async function waitNoLeftoverTmpZips(baseline, turns = 200) {
  const known = new Set(baseline);
  const settled = (names) => names.every((name) => known.has(name));
  let current = await leftoverTmpZips();
  for (let index = 0; index < turns && !settled(current); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = await leftoverTmpZips();
  }
  return current;
}

test('工作区里的文件：ok，size 与 mtime 与盘上一致', async (t) => {
  const dir = await workspace(t);
  const content = '第一行\nhello\n';
  await fs.writeFile(path.join(dir, 'a.md'), content, 'utf8');
  const info = await fs.stat(path.join(dir, 'a.md'));

  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: ['a.md'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items.length, 1);
    const [row] = res.body.items;
    assert.equal(row.path, 'a.md');
    assert.equal(row.status, 'ok');
    assert.equal(row.size, Buffer.byteLength(content));
    assert.equal(row.mtime, Math.round(info.mtimeMs));
    // 工作区那一侧认了就不该去读历史：一次 stat 一次的活，不必拉整窗历史。
    assert.equal(host.calls.history, 0);
  });
});

test('工作区外没声明过的路径 → denied，且不许变成 4xx', async (t) => {
  const dir = await workspace(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artifacts-out-'));
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
  const outsideFile = path.join(outside, 'secret.txt');
  await fs.writeFile(outsideFile, 'nope', 'utf8');

  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: [outsideFile, `../${path.basename(outside)}/secret.txt`] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, [
      { path: outsideFile, status: 'denied' },
      { path: `../${path.basename(outside)}/secret.txt`, status: 'denied' },
    ]);
  });
});

test('声明过的工作区外路径 → ok（同一份放行面）', async (t) => {
  const dir = await workspace(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artifacts-decl-'));
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
  const outsideFile = path.join(outside, 'report.pdf');
  await fs.writeFile(outsideFile, '%PDF-1.4\n', 'utf8');

  await withHost({ cwd: dir, events: [presented(1, [outsideFile])] }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: [outsideFile] });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].status, 'ok');
    assert.equal(res.body.items[0].size, Buffer.byteLength('%PDF-1.4\n'));
  });
});

test('盘上删掉 → missing，整条请求仍是 200', async (t) => {
  const dir = await workspace(t);
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: ['gone.md', 'also-gone.png'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, [
      { path: 'gone.md', status: 'missing' },
      { path: 'also-gone.png', status: 'missing' },
    ]);
  });
});

test('目录不是文件 → missing（不是 400，整条请求也不许失败）', async (t) => {
  const dir = await workspace(t);
  await fs.mkdir(path.join(dir, 'out'));
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: ['out'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, [{ path: 'out', status: 'missing' }]);
  });
});

test('读历史失败：那一条标 denied，不要把它变成 5xx', async (t) => {
  const dir = await workspace(t);
  // 工作区外的一条：判定必须先读历史，而历史这一下是坏的。
  const outside = path.join(os.tmpdir(), 'dsh-artifacts-nope', 'outside.txt');
  await withHost({ cwd: dir, historyError: { code: 'boom', message: '宿主炸了' } }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: [outside] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, [{ path: outside, status: 'denied' }]);
  });
});

test('超过 200 条 / 类型不对 / 缺参数 → 400', async (t) => {
  const dir = await workspace(t);
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const many = Array.from({ length: artifacts.MAX_ARTIFACT_PATHS + 1 }, (_, i) => `f${i}.md`);
    const tooMany = await host.artifacts({ sessionId: 's1', paths: many });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'bad-request');

    const notArray = await host.artifacts({ sessionId: 's1', paths: 'a.md' });
    assert.equal(notArray.status, 400);

    const badItem = await host.artifacts({ sessionId: 's1', paths: ['a.md', ''] });
    assert.equal(badItem.status, 400);

    const noSession = await host.artifacts({ paths: ['a.md'] });
    assert.equal(noSession.status, 400);
  });
});

test('stat 并发上限是 8，且结果顺序与请求一致', async (t) => {
  const dir = await workspace(t);
  const paths = [];
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(path.join(dir, `f${index}.md`), 'x', 'utf8');
    paths.push(`f${index}.md`);
  }
  // 记一下同时在飞的 stat 有几条：一屏 200 行串行跑会把开屏拖成几百毫秒，真并发 200 条
  // 又会把 IO 打满（这条接口不该是后者的形状）。
  let live = 0;
  let peak = 0;
  const real = fs.stat;
  try {
    artifacts.__setStatForTests(async (target) => {
      live += 1;
      if (live > peak) peak = live;
      try {
        return await new Promise((resolve, reject) => {
          // 让出一次事件循环，好让「同时在飞」真的看得见。
          setImmediate(() => real(target).then(resolve, reject));
        });
      } finally {
        live -= 1;
      }
    });
    await withHost({ cwd: dir, events: [] }, async (host) => {
      const res = await host.artifacts({ sessionId: 's1', paths });
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 40);
      assert.deepEqual(res.body.items.map((row) => row.path), paths, '结果顺序必须与请求一致');
    });
  } finally {
    artifacts.__setStatForTests(null);
  }
  assert.equal(peak, artifacts.ARTIFACT_STAT_CONCURRENCY, `并发峰值应当正好是 ${artifacts.ARTIFACT_STAT_CONCURRENCY}，实际 ${peak}`);
});

test('重复路径去重后只回一条', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'a.md'), 'x', 'utf8');
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.artifacts({ sessionId: 's1', paths: ['a.md', 'a.md', 'a.md'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
  });
});

test('打包：内容对得上、条目名是 basename、同名去重、缺失那条被跳过', async (t) => {
  const dir = await workspace(t);
  const contentA = '甲文件的内容\n';
  const contentB = '乙文件的内容\n';
  await fs.mkdir(path.join(dir, 'out'));
  await fs.mkdir(path.join(dir, 'other'));
  await fs.writeFile(path.join(dir, 'out', 'a.txt'), contentA, 'utf8');
  await fs.writeFile(path.join(dir, 'other', 'a.txt'), contentB, 'utf8');

  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.archive({ sessionId: 's1', paths: ['out/a.txt', 'other/a.txt', 'missing.md'] });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'application/zip');
    assert.match(res.headers.disposition, /filename="dsh-artifacts-\d{8}\.zip"/);
    // content-length 必须正好是这份 zip 的字节数：安卓那个原生下载器按它判收没收完。
    assert.equal(Number(res.headers.length), res.bytes.length);

    const entries = unzip(res.bytes);
    assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'a (2).txt']);
    assert.equal(entries[0].content.toString('utf8'), contentA);
    assert.equal(entries[1].content.toString('utf8'), contentB);
    for (const entry of entries) assert.equal(entry.size, entry.content.length);
  });
});

test('条目名只有 basename：zip 里不出现目录与 ..', async (t) => {
  const dir = await workspace(t);
  await fs.mkdir(path.join(dir, 'deep', 'nested'), { recursive: true });
  await fs.writeFile(path.join(dir, 'deep', 'nested', 'x.csv'), 'a,b\n', 'utf8');
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.archive({ sessionId: 's1', paths: ['deep/nested/x.csv'] });
    const entries = unzip(res.bytes);
    assert.deepEqual(entries.map((entry) => entry.name), ['x.csv']);
  });
});

test('一条可用文件都没有 → 404 empty-archive，且不留下临时 zip', async (t) => {
  const dir = await workspace(t);
  const before = await leftoverTmpZips();
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.archive({ sessionId: 's1', paths: ['gone.md', 'nope.png'] });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'empty-archive');
  });
  assert.deepEqual(await waitNoLeftoverTmpZips(before), before, '空包那条路不该建临时文件，建了也不许留下');
});

test('paths 为空 / 类型不对 → 400 bad-request', async (t) => {
  const dir = await workspace(t);
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const empty = await host.archive({ sessionId: 's1', paths: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'bad-request');
    const notArray = await host.archive({ sessionId: 's1', paths: 42 });
    assert.equal(notArray.status, 400);
  });
});

test('明文总量超过 512MB → 413 too-large（用假 stat 尺寸，不真写大文件）', async (t) => {
  const dir = await workspace(t);
  const fake = path.join(dir, 'huge.bin');
  const real = fs.stat;
  try {
    artifacts.__setStatForTests(async (target) => {
      if (target === fake) {
        return { isFile: () => true, size: artifacts.ARCHIVE_MAX_BYTES + 1, mtimeMs: 1763000000000 };
      }
      return real(target);
    });
    await withHost({ cwd: dir, events: [] }, async (host) => {
      const res = await host.archive({ sessionId: 's1', paths: ['huge.bin'] });
      assert.equal(res.status, 413);
      assert.equal(res.body.error.code, 'too-large');
    });
  } finally {
    artifacts.__setStatForTests(null);
  }
});

test('打包中途读不到文件：500 archive-failed，成功与失败两条路都不留临时 zip', async (t) => {
  const dir = await workspace(t);
  const one = path.join(dir, 'ok.md');
  await fs.writeFile(one, 'ok\n', 'utf8');
  const ghost = path.join(dir, 'ghost.md');
  const before = await leftoverTmpZips();
  const real = fs.stat;
  try {
    // 判定那一步说「有」，真读的时候没有 —— 这是「打到一半出错」的现实形状（文件被挪走）。
    artifacts.__setStatForTests(async (target) => {
      if (target === ghost) return { isFile: () => true, size: 10, mtimeMs: 1763000000000 };
      return real(target);
    });
    await withHost({ cwd: dir, events: [] }, async (host) => {
      const res = await host.archive({ sessionId: 's1', paths: ['ok.md', 'ghost.md'] });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, 'archive-failed');
    });
  } finally {
    artifacts.__setStatForTests(null);
  }
  assert.deepEqual(await waitNoLeftoverTmpZips(before), before, '打包失败那条路必须把临时 zip 删掉');
});

test('成功那条路也不留临时 zip', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'a.md'), 'x', 'utf8');
  const before = await leftoverTmpZips();
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.archive({ sessionId: 's1', paths: ['a.md'] });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(await waitNoLeftoverTmpZips(before), before, '成功那条路必须把临时 zip 删掉');
});

test('协议 v2：分块信封的头带 zip 大小与加密后长度，解出来仍是那份 zip', async (t) => {
  const dir = await workspace(t);
  // 压不动的内容（随机字节最不容易被 deflate 吃掉）跨过好几个 64KB 块：写块那条路的分块
  // 边界必须与 App 那边的读法对得上，一份小的证明不了这件事。
  const content = Buffer.alloc(FILE_CHUNK_BYTES * 3 + 1234);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 37 + 11) & 0xff;
  await fs.writeFile(path.join(dir, 'blob.bin'), content);
  const nonce = e2ee.b64url(Buffer.alloc(12, 0x44));

  await withHost({ cwd: dir, events: [], e2eeNonce: nonce }, async (host) => {
    const res = await host.archive({ sessionId: 's1', paths: ['blob.bin'] });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'application/x-dsh-e2ee-chunks');
    assert.equal(res.headers.proto, '2');
    assert.equal(res.headers.innerType, 'application/zip');
    const zipSize = Number(res.headers.fileSize);
    assert.ok(zipSize > 0);
    assert.equal(Number(res.headers.length), zipSize + (Math.floor(zipSize / FILE_CHUNK_BYTES) + 1) * (4 + 12 + 16));
    assert.equal(res.bytes.length, Number(res.headers.length));

    // 按块解回来：`[4 字节长度][12 字节 nonce][密文+tag]`，AAD 绑路径 / 请求 nonce / 块序号。
    const plain = [];
    let offset = 0;
    let seq = 0;
    const aadPath = `${BASE}/archive`;
    while (offset < res.bytes.length) {
      // 长度字段写的是「密文 + tag」，前面还有 4 字节长度与 12 字节 nonce。
      const sealedLength = res.bytes.readUInt32BE(offset);
      const sealed = res.bytes.subarray(offset + 4, offset + 4 + e2ee.NONCE_BYTES + sealedLength);
      seq += 1;
      plain.push(Buffer.from(e2ee.open(TEST_KEYS.down, sealed, e2ee.fileAad(aadPath, nonce, seq))));
      offset += 4 + e2ee.NONCE_BYTES + sealedLength;
    }
    const zip = Buffer.concat(plain);
    assert.equal(zip.length, zipSize);
    const entries = unzip(zip);
    assert.deepEqual(entries.map((entry) => entry.name), ['blob.bin']);
    assert.deepEqual(entries[0].content, content);
  });
});

/**
 * 源码契约：`buildZipToFile` 里写条目必须**串行**。
 *
 * `appendBytes` 不带 position，靠的是「文件当前写指针往后追加」；而写指针只有一条。两条并发
 * 写会互相插进对方的字节中间，产出的是**结构合法、内容错位**的 zip —— 解压器不报错，打开却
 * 是别人的内容。这条不靠「跑一遍看不出来」兜着，直接钉住那个循环的形状。
 */
test('源码契约：写 zip 条目是串行 for-of，没有并发写', () => {
  const source = readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'session-artifacts.js'), 'utf8');
  const start = source.indexOf('async function buildZipToFile(');
  assert.ok(start > 0, 'buildZipToFile 不见了');
  const body = source.slice(start, source.indexOf('\nfunction tmpZipPathOf('));
  // 写条目那个循环必须是 for-of，循环体里 await 一条一条走。
  assert.match(body, /for \(const entry of entries\) \{\s*\n\s*const row = await writeZipEntry\(/, '写条目那个循环必须串行 for-of');
  // 不许出现「并发写同一份文件」的形状。
  assert.doesNotMatch(body, /Promise\.all\s*\(/, 'buildZipToFile 不许并发写：appendBytes 依赖文件当前位置');
  assert.doesNotMatch(body, /Promise\.allSettled\s*\(/, 'buildZipToFile 不许并发写：appendBytes 依赖文件当前位置');
});

test('crc32 与 zlib 的口径一致（zip 的中央目录要的是这个值）', () => {
  for (const sample of ['', 'a', 'hello world', '中文内容\n'.repeat(3)]) {
    const bytes = Buffer.from(sample, 'utf8');
    assert.equal(artifacts.crc32Update(0, bytes), zlib.crc32(bytes));
  }
  // 分两段喂与一次喂完必须同值：zip 是边读边算的。
  const head = Buffer.from('前半段', 'utf8');
  const tail = Buffer.from('后半段', 'utf8');
  const once = artifacts.crc32Update(0, Buffer.concat([head, tail]));
  assert.equal(artifacts.crc32Update(artifacts.crc32Update(0, head), tail), once);
});

test('同名去重按 a.txt / a (2).txt / a (3).txt 递进，且保留扩展名', () => {
  const taken = new Set();
  assert.equal(artifacts.entryNameOf('/w/a.txt', taken), 'a.txt');
  assert.equal(artifacts.entryNameOf('/x/a.txt', taken), 'a (2).txt');
  assert.equal(artifacts.entryNameOf('/y/a.txt', taken), 'a (3).txt');
  assert.equal(artifacts.entryNameOf('/z/b.md', taken), 'b.md');
  assert.equal(artifacts.entryNameOf('/z/noext', taken), 'noext');
});
