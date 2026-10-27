'use strict';

/**
 * 按路径读文件（POST /api/mobile/v1/file/read）的契约。
 *
 * 这条路由存在的理由是右栏文件浏览器：手里只有一串路径，而 `/session/file` 只认「本会话
 * 工作区 ∪ 本轮交付声明」。它的边界比实现重要，所以逐条钉住：
 *
 *  1. **允许区 = 宿主已登记的工作区 ∪ （给了 sessionId 时）这条会话的项目目录**，判的是
 *     resolve 之后的落点：`..` 爬出去、以及名字只是**前缀相同**的隔壁目录都不认，回 403
 *     `outside-allowed`，且一次盘都不碰 —— 这是「移动 API 不暴露任意读」的执行点。
 *  2. `path` 必须绝对：相对路径没有可信基准，回 400 而不是去猜。
 *  3. 认了之后的失败分开报：盘上没有 404 `missing`、目录 400 `not-a-file`、超 512MB 413。
 *  4. 回的是原始字节 + 与扩展名对得上的 `content-type` + 准确的 `content-length`，不是 JSON。
 *  5. 协议 v2 下与 `/session/file` **同一个信封**：chunked、`x-dsh-proto: 2`、
 *     `x-dsh-content-type` 带明文类型；这里按 §8.3(6) 把块切回来，用宿主自己的 `e2ee.open`
 *     加 `fileAad(请求路径, nonce, seq)` 解 —— 形状或 AAD 绑错，这一步就解不出来。
 *  6. 宿主工作区清单报错要如实回 502：当成空清单会让每个路径都变成 403，用户看到的是
 *     「我的目录突然不能看了」。
 *
 * 起真 http 服务、真读临时目录，只有宿主那一侧是假对象。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { handleFileRead } = require('../lib/mobile/file-read.js');
const e2ee = require('../lib/shared/e2ee.js');
const { readWiring } = require('./lib/wiring.cjs');

const BASE = '/api/mobile/v1/file/read';

/**
 * 起一个只挂这条路由的服务；宿主 workspace.* / sessions.* 是假对象。
 *
 * @param {object} options
 * @param {string[]} [options.workspaces] 宿主登记的工作区目录
 * @param {string} [options.cwd] 会话项目目录
 * @param {object} [options.workspaceError] workspace.list 回错误的 error 对象
 * @param {boolean} [options.workspaceShapeBad] workspace.list 回一个没有 items 的 value
 * @param {boolean} [options.e2ee] 挂上协议 v2 的会话密钥（模拟 guarded 解封之后的状态）
 */
async function serve(options = {}) {
  const calls = { workspace: 0, list: 0 };
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => {
          calls.workspace += 1;
          if (options.workspaceError) return { result: { ok: false, error: options.workspaceError } };
          if (options.workspaceShapeBad) return { result: { ok: true, value: {} } };
          return {
            result: {
              ok: true,
              value: { items: (options.workspaces || []).map((dir) => ({ workspaceId: 'w1', path: dir })) },
            },
          };
        },
      },
      sessions: {
        list: async () => {
          calls.list += 1;
          return { result: { ok: true, value: { items: [{ sessionId: 's1', cwd: options.cwd ?? null }] } } };
        },
      },
    },
  };
  const opened = options.e2ee
    ? {
      keys: e2ee.deriveSessionKeys(Buffer.alloc(32, 0x22)),
      req: { ts: 1, nonce: e2ee.b64url(Buffer.alloc(12, 0x44)) },
    }
    : null;

  const server = http.createServer((req, res) => {
    // `req.__dshE2ee` 平时由 `createGuarded` 解封时挂上，这里直接画上同一个形状。
    if (opened) req.__dshE2ee = opened;
    Promise.resolve(handleFileRead(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch { /* 连接已关闭 */ }
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    opened,
    post: async (body) => {
      const response = await fetch(`${origin}${BASE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const type = response.headers.get('content-type') || '';
      const bytes = Buffer.from(await response.arrayBuffer());
      if (type.startsWith('application/json')) {
        return { status: response.status, body: JSON.parse(bytes.toString('utf8') || '{}'), type, headers: response.headers };
      }
      return { status: response.status, bytes, type, headers: response.headers };
    },
    close: () => new Promise((resolve) => {
      // fetch 的 keep-alive 空闲连接会让 close 干等。
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

/** 建一个临时目录，用例结束时删掉。 */
async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/** 按 §8.3(6) 切块并用宿主自己的实现解开；形状对不上这里会直接抛。 */
function decodeChunks(keys, requestNonce, raw) {
  const out = [];
  let offset = 0;
  let seq = 0;
  while (offset < raw.length) {
    // 长度字段写的是「密文 + tag」，nonce 与长度字段本身都不算在内。
    const len = raw.readUInt32BE(offset);
    offset += 4;
    const sealed = raw.subarray(offset, offset + e2ee.NONCE_BYTES + len);
    offset += e2ee.NONCE_BYTES + len;
    seq += 1;
    // AAD 绑的是这条请求自己的路径（`signedPath` 从 `/api/mobile/v1/` 起算），块序号让中转
    // 既搬不了别的文件、也重排不了这份的块。
    out.push(e2ee.open(keys.down, sealed, e2ee.fileAad(BASE, requestNonce, seq)));
  }
  return Buffer.concat(out);
}

test('工作区里的文件：回原始字节，类型按扩展名，长度对得上', async (t) => {
  const ws = await tempDir(t, 'dsh-file-read-ws-');
  const text = '# 星尘笔记\n正文\n';
  await fs.mkdir(path.join(ws, 'docs'));
  await fs.writeFile(path.join(ws, 'docs', '说明.md'), text, 'utf8');
  await fs.writeFile(path.join(ws, 'docs', 'clip.mp4'), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  await fs.writeFile(path.join(ws, '空文件.txt'), '', 'utf8');

  await withHost({ workspaces: [ws] }, async (host) => {
    const md = await host.post({ path: path.join(ws, 'docs', '说明.md') });
    assert.equal(md.status, 200);
    assert.equal(md.type, 'text/plain; charset=utf-8');
    assert.equal(md.headers.get('content-length'), String(Buffer.byteLength(text)));
    assert.equal(md.bytes.toString('utf8'), text);
    assert.match(md.headers.get('content-disposition'), /filename="说明\.md"|filename\*=UTF-8''%E8%AF%B4%E6%98%8E\.md/);

    const mp4 = await host.post({ path: path.join(ws, 'docs', 'clip.mp4') });
    assert.equal(mp4.status, 200);
    assert.equal(mp4.type, 'video/mp4');

    // 空文件也要收尾（0 字节 + content-length: 0），不能挂在那儿等超时。
    const empty = await host.post({ path: path.join(ws, '空文件.txt') });
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-length'), '0');
    assert.equal(empty.bytes.length, 0);
  });
});

test('工作区外一条都不给：403 outside-allowed，前缀相同的隔壁目录也不认', async (t) => {
  const ws = await tempDir(t, 'dsh-file-read-ws-');
  // 名字只是**以工作区路径为前缀**的隔壁目录：按字符串前缀判会错放，按落点判才挡得住。
  const sibling = `${ws}-evil`;
  await fs.mkdir(sibling, { recursive: true });
  t.after(async () => { await fs.rm(sibling, { recursive: true, force: true }); });
  await fs.writeFile(path.join(sibling, 'secret.txt'), 'nope', 'utf8');

  await withHost({ workspaces: [ws] }, async (host) => {
    const prefix = await host.post({ path: path.join(sibling, 'secret.txt') });
    assert.equal(prefix.status, 403);
    assert.equal(prefix.body.error.code, 'outside-allowed');

    // 用 `..` 从工作区里爬出去，解析后落在外面 —— 同样不认。
    const escape = await host.post({ path: path.join(ws, 'docs', '..', '..', path.basename(sibling), 'secret.txt') });
    assert.equal(escape.status, 403);
    assert.equal(escape.body.error.code, 'outside-allowed');
  });
});

test('缺 path 或相对路径：400，且不去问宿主', async () => {
  await withHost({ workspaces: [] }, async (host) => {
    const missing = await host.post({ sessionId: 's1' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'bad-request');

    const relative = await host.post({ sessionId: 's1', path: 'docs/报告.md' });
    assert.equal(relative.status, 400);
    assert.equal(relative.body.error.code, 'bad-request');
    assert.equal(host.calls.workspace, 0);
  });
});

test('允许区内、盘上没有 → 404；目录 → 400；超 512MB → 413', async (t) => {
  const ws = await tempDir(t, 'dsh-file-read-ws-');
  await fs.mkdir(path.join(ws, 'docs'));
  const huge = path.join(ws, 'huge.bin');
  await fs.writeFile(huge, 'x');
  // 稀疏文件：几百 MB 不真占盘，只是为了撞上限那一条分支。
  await fs.truncate(huge, 512 * 1024 * 1024 + 1);

  await withHost({ workspaces: [ws] }, async (host) => {
    const gone = await host.post({ path: path.join(ws, 'docs', 'gone.png') });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, 'missing');

    const dir = await host.post({ path: path.join(ws, 'docs') });
    assert.equal(dir.status, 400);
    assert.equal(dir.body.error.code, 'not-a-file');

    const tooBig = await host.post({ path: huge });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error.code, 'too-large');
  });
});

test('会话的项目目录：带了 sessionId 才放行，没带就是工作区之外', async (t) => {
  // cwd 刻意**不登记**成工作区：右栏从会话进的文件树就是这种形状。
  const cwd = await tempDir(t, 'dsh-file-read-cwd-');
  const file = path.join(cwd, 'main.c');
  await fs.writeFile(file, 'int main(void) { return 0; }\n', 'utf8');
  const other = await tempDir(t, 'dsh-file-read-ws-');

  await withHost({ workspaces: [other], cwd }, async (host) => {
    const narrow = await host.post({ path: file });
    assert.equal(narrow.status, 403);
    assert.equal(narrow.body.error.code, 'outside-allowed');

    const withSession = await host.post({ path: file, sessionId: 's1' });
    assert.equal(withSession.status, 200);
    assert.equal(withSession.type, 'text/plain; charset=utf-8');
    assert.equal(withSession.bytes.toString('utf8'), 'int main(void) { return 0; }\n');
  });
});

test('宿主工作区清单报错：502 如实回错，不当成空清单', async () => {
  await withHost({ workspaceError: { code: 'host-workspace-baseline-missing', message: '没有 baseline 帧' } }, async (host) => {
    const res = await host.post({ path: path.join(os.tmpdir(), 'whatever.txt') });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'host-workspace-baseline-missing');
    assert.match(res.body.error.message, /没有 baseline 帧/);
  });
});

test('宿主清单形状不对（没有 items）：502，不兜底成空清单', async () => {
  await withHost({ workspaceShapeBad: true }, async (host) => {
    const res = await host.post({ path: path.join(os.tmpdir(), 'whatever.txt') });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'host-workspace-list-degraded');
  });
});

test('协议 v2：与 /session/file 同一个分块信封，块能用请求路径的 AAD 解回来', async (t) => {
  const ws = await tempDir(t, 'dsh-file-read-ws-');
  const content = Buffer.from(`${'块'.repeat(40 * 1024)}\n尾巴`);
  await fs.writeFile(path.join(ws, 'big.md'), content);

  await withHost({ workspaces: [ws], e2ee: true }, async (host) => {
    const res = await host.post({ path: path.join(ws, 'big.md') });
    assert.equal(res.status, 200);
    // 信封外壳：这份字节不是原文，长度改成 chunked，明文类型单独给一份。
    assert.equal(res.type, 'application/x-dsh-e2ee-chunks');
    assert.equal(res.headers.get('x-dsh-proto'), '2');
    assert.equal(res.headers.get('x-dsh-content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('content-length'), null);

    const plain = decodeChunks(host.opened.keys, host.opened.req.nonce, res.bytes);
    assert.deepEqual(plain, content);
  });
});

test('路由接线：/file/read 挂在移动端路由表上，且引入了 handler 模块', () => {
  const wiring = readWiring();
  assert.ok(
    wiring.includes("route('/api/mobile/v1/file/read', fileRead.handleFileRead)"),
    '路由表缺少 /api/mobile/v1/file/read',
  );
  assert.match(wiring, /require\(['"](?:\.\.?\/mobile)\/file-read\.js['"]\)/);
});
