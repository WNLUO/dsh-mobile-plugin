'use strict';

/**
 * 无限画布的库（`/canvas/manifest`、`/canvas/manifest/save`、`/canvas/file`，以及分片上传
 * 里 `purpose: 'canvas'` 那一支）。
 *
 * 每条断言对着一个真会出事的写法：
 *
 *  1. **清单必须只在字节齐了之后才写得进去**：一份指向不存在哈希的清单，在手机上表现为
 *     「画布能打开、图全是坏的」，而且下一次同步会把它当成已同步 —— 坏得无声无息。
 *  2. **字节只按哈希认**：客户端给不了路径，`../` 这种形状必须直接 400，不能落成路径。
 *  3. **清单读不懂要如实报错**，不能当成「还没有清单」—— 那样手机把本机那份推上来就把
 *     远端整份盖掉了。
 *  4. **版本号由内容算**：同一份内容两次写入版本号相同（条件刷新才有意义），内容变了才变。
 *  5. **收进库的素材不进收件箱**：`purpose: 'canvas'` 与 `destPath` 互斥，传完回的是哈希
 *     不是路径；同内容再传一次不去重出第二份。
 *
 * 驱动真实 handler（起真 http 服务、走真 req/res），只有库根是临时目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  handleCanvasManifestGet,
  handleCanvasManifestSave,
  handleCanvasFile,
  objectPathOf,
  rootDir,
} = require('../lib/mobile/canvas-store.js');
const {
  handleUploadBegin,
  handleUploadChunk,
  handleUploadFinish,
} = require('../lib/mobile/uploads.js');
const { readRouteTable } = require('./lib/wiring.cjs');

const HASH_OF = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** 起一个只挂这几条 handler 的真 http 服务；库根与收件根都指向临时目录。 */
async function serve(libraryRoot, inbox) {
  process.env.DSH_MOBILE_CANVAS = libraryRoot;
  process.env.DSH_MOBILE_INBOX = inbox;
  const server = http.createServer((req, res) => {
    const route = String(req.url || '').split('?')[0];
    const handler = {
      '/canvas/manifest': handleCanvasManifestGet,
      '/canvas/manifest/save': handleCanvasManifestSave,
      '/canvas/file': handleCanvasFile,
      '/upload/begin': handleUploadBegin,
      '/upload/chunk': handleUploadChunk,
      '/upload/finish': handleUploadFinish,
    }[route];
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    void handler({}, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: async (route, body) => {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    get: async (route) => {
      const response = await fetch(base + route);
      return { status: response.status, body: await response.json() };
    },
    /** 传一份字节进画布库，返回 finish 的回执（`hash` / `bytes`）。 */
    upload: async (name, bytes) => {
      const begin = await fetch(base + '/upload/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, purpose: 'canvas' }),
      }).then((r) => r.json());
      assert.equal(begin.ok, true, JSON.stringify(begin));
      const data = Buffer.from(bytes).toString('base64');
      const chunk = await fetch(base + '/upload/chunk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: begin.uploadId, index: 0, data }),
      }).then((r) => r.json());
      assert.equal(chunk.ok, true, JSON.stringify(chunk));
      return fetch(base + '/upload/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: begin.uploadId }),
      }).then((r) => r.json());
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function tempRoots(t) {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-lib-'));
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-inbox-'));
  t.after(() => {
    fs.rmSync(library, { recursive: true, force: true });
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_CANVAS;
    delete process.env.DSH_MOBILE_INBOX;
  });
  return { library, inbox };
}

test('素材上传：回哈希、落进按哈希分两级的目录、不进收件箱；同内容只留一份', async (t) => {
  const { library, inbox } = tempRoots(t);
  const api = await serve(library, inbox);
  try {
    const bytes = Buffer.from('canvas-image-bytes');
    const first = await api.upload('一张图.png', bytes);
    assert.equal(first.ok, true);
    const hash = HASH_OF(bytes);
    assert.equal(first.hash, hash);
    assert.equal(first.bytes, bytes.length);
    // 回执里没有路径：客户端拿不到、也拼不出库里的路径。
    assert.equal(first.path, undefined);

    const stored = objectPathOf(hash);
    assert.equal(stored, path.join(library, 'objects', hash.slice(0, 2), hash.slice(2)));
    assert.deepEqual(fs.readFileSync(stored), bytes);
    // 收件箱里一个新文件都没有（只有 .staging 那个空目录）。
    const stray = fs.readdirSync(inbox).filter((name) => name !== '.staging');
    assert.deepEqual(stray, []);

    // 同一份字节再传一次：哈希一样、盘上还是只有那一份。
    const again = await api.upload('换个名字.png', bytes);
    assert.equal(again.hash, hash);
    const objects = fs.readdirSync(path.join(library, 'objects', hash.slice(0, 2)));
    assert.deepEqual(objects, [hash.slice(2)]);
  } finally {
    await api.close();
  }
});

test('清单：字节没到位就写不进去，字节到位才认，版本号跟着内容走', async (t) => {
  const { library, inbox } = tempRoots(t);
  const api = await serve(library, inbox);
  try {
    const bytes = Buffer.from('media-1');
    const hash = HASH_OF(bytes);
    const files = [{ storageKey: 'image:abc', hash, mimeType: 'image/png', bytes: bytes.length }];
    const data = { projects: [{ id: 'p1', title: '画布一', updatedAt: '2026-11-03T00:00:00.000Z' }] };

    // 字节还没传上来：整份拒绝，且盘上不落清单文件（下一次读仍是「空库」）。
    const refused = await api.post('/canvas/manifest/save', { domain: 'canvas', data, files });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'missing-file');
    assert.deepEqual(refused.body.error.missing, ['image:abc']);
    assert.equal(fs.existsSync(path.join(library, 'manifest-canvas.json')), false);

    await api.upload('media-1.bin', bytes);
    const saved = await api.post('/canvas/manifest/save', { domain: 'canvas', data, files });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.files, 1);
    const revision = saved.body.revision;
    assert.match(revision, /^[0-9a-f]{16}$/);

    // 带同一个 rev 只回一句 unchanged，不带 data —— 画布每开一次都同步，稳态那一发要小。
    const unchanged = await api.get('/canvas/manifest?domain=canvas&rev=' + revision);
    assert.equal(unchanged.body.unchanged, true);
    assert.equal(unchanged.body.data, undefined);

    // 不带 rev 拿全份，内容与写进去的一致。
    const full = await api.get('/canvas/manifest?domain=canvas');
    assert.equal(full.body.revision, revision);
    assert.deepEqual(full.body.data, data);
    assert.deepEqual(full.body.files, files);

    // 同一份内容再写一次：版本号必须一样（否则条件刷新永远对不上）。
    const same = await api.post('/canvas/manifest/save', { domain: 'canvas', data, files });
    assert.equal(same.body.revision, revision);

    // 内容变了才变。
    const changed = await api.post('/canvas/manifest/save', {
      domain: 'canvas',
      data: { ...data, projects: [{ ...data.projects[0], title: '画布二' }] },
      files,
    });
    assert.notEqual(changed.body.revision, revision);
  } finally {
    await api.close();
  }
});

test('清单：没有清单回 empty，坏掉的清单如实报错、不当成空库', async (t) => {
  const { library, inbox } = tempRoots(t);
  const api = await serve(library, inbox);
  try {
    const empty = await api.get('/canvas/manifest?domain=assets');
    assert.equal(empty.body.empty, true);
    assert.equal(empty.body.revision, null);

    fs.mkdirSync(rootDir(), { recursive: true });
    fs.writeFileSync(path.join(library, 'manifest-assets.json'), '{坏掉的 JSON', 'utf8');
    const broken = await api.get('/canvas/manifest?domain=assets');
    assert.equal(broken.status, 500);
    assert.equal(broken.body.error.code, 'manifest-corrupt');
  } finally {
    await api.close();
  }
});

test('取字节：按哈希取回原样字节；形状不对 400，没有的 404', async (t) => {
  const { library, inbox } = tempRoots(t);
  const api = await serve(library, inbox);
  try {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const hash = HASH_OF(bytes);
    await api.upload('bin.dat', bytes);

    const response = await fetch(api.base + '/canvas/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

    for (const bad of ['', '../etc/passwd', 'x'.repeat(64), 123]) {
      const badResponse = await api.post('/canvas/file', { hash: bad });
      assert.equal(badResponse.status, 400, `hash=${String(bad)} 该被拒`);
    }
    const missing = await api.post('/canvas/file', { hash: 'a'.repeat(64) });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'missing');
  } finally {
    await api.close();
  }
});

test('入参校验：域、files 形状、storageKey、purpose 与 destPath 互斥', async (t) => {
  const { library, inbox } = tempRoots(t);
  const api = await serve(library, inbox);
  try {
    const cases = [
      [{ domain: 'whatever', data: {}, files: [] }, 'bad-domain'],
      [{ domain: 'canvas', data: [], files: [] }, 'bad-data'],
      [{ domain: 'canvas', data: {}, files: 'nope' }, 'bad-files'],
      [{ domain: 'canvas', data: {}, files: [{ storageKey: '', hash: 'a'.repeat(64), bytes: 1 }] }, 'bad-files'],
      [{ domain: 'canvas', data: {}, files: [{ storageKey: 'k', hash: 'short', bytes: 1 }] }, 'bad-files'],
      [{ domain: 'canvas', data: {}, files: [{ storageKey: 'k', hash: 'a'.repeat(64), bytes: -1 }] }, 'bad-files'],
      [{ domain: 'canvas', data: {}, files: [{ storageKey: `k${'\u0007'}`, hash: 'a'.repeat(64), bytes: 1 }] }, 'bad-files'],
    ];
    for (const [body, code] of cases) {
      const result = await api.post('/canvas/manifest/save', body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, code, JSON.stringify(body));
    }

    const badPurpose = await api.post('/upload/begin', { name: 'x.png', purpose: 'elsewhere' });
    assert.equal(badPurpose.status, 400);
    assert.equal(badPurpose.body.error.code, 'bad-purpose');

    const both = await api.post('/upload/begin', { name: 'x.png', purpose: 'canvas', destPath: inbox });
    assert.equal(both.status, 400);
    assert.equal(both.body.error.code, 'bad-request');
  } finally {
    await api.close();
  }
});

test('接线：三条画布路由都在移动端路由表里', () => {
  const table = readRouteTable();
  for (const route of ['/api/mobile/v1/canvas/manifest', '/api/mobile/v1/canvas/manifest/save', '/api/mobile/v1/canvas/file']) {
    assert.ok(table.includes(`'${route}'`), `路由表里没有 ${route}`);
  }
});
