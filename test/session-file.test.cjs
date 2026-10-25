'use strict';

/**
 * 交付文件取字节（POST /api/mobile/v1/session/file）的契约。
 *
 * 这条路由的边界比它的实现重要，所以逐条钉住：
 *
 *  1. **放行面是两条**：本会话工作区里的文件（按解析后的落点判，`../` 爬出去不算），
 *     以及本会话 present 声明过的路径（字符串全等）。两条都不认的路径一次盘都不碰，
 *     回 403 —— 这是「移动 API 不暴露任意读」的唯一执行点。
 *  2. **相对路径按会话 cwd 解析**，绝对路径原样。
 *  3. 认了、盘上没有 → 404；认的是个目录 → 400。两种都不是「路径有问题」。
 *  4. 回的是原始字节 + 与扩展名对得上的 `content-type` / 准确的 `content-length`，
 *     不是 JSON 信封 —— App 那边直接读 arrayBuffer。
 *  5. 走进声明那条路时读历史失败 → 502，不能假装成「没有声明」。
 *
 * 起真 http 服务、真读临时目录，只有宿主那一侧是假对象。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { handleSessionFile } = require('../lib/mobile/session-file.js');

const BASE = '/api/mobile/v1/session/file';

/** 一条交付声明事件（形状与宿主 dsh-tool-present 追加的那条一致）。 */
function presented(turn, paths) {
  return {
    type: 'deliverables/presented',
    data: { turn, files: paths.map((item) => (typeof item === 'string' ? { path: item } : item)) },
  };
}

/**
 * 起一个只挂这条路由的服务；宿主 sessions.* 是假对象。
 *
 * @param {object} options
 * @param {string} [options.cwd] 会话工作区（相对路径的解析基准）
 * @param {object[]} [options.events] 历史事件
 * @param {object} [options.historyError] history 回错误时的 error 对象
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
    Promise.resolve(handleSessionFile(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    post: async (body) => {
      const response = await fetch(`${origin}${BASE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const type = response.headers.get('content-type') || '';
      const length = response.headers.get('content-length');
      const disposition = response.headers.get('content-disposition');
      if (type.startsWith('application/json')) {
        return { status: response.status, body: await response.json(), type, length, disposition };
      }
      const buf = Buffer.from(await response.arrayBuffer());
      return { status: response.status, bytes: buf, type, length, disposition };
    },
    close: () => new Promise((resolve) => {
      // fetch 的 keep-alive 连接会让 close 干等：先断掉空闲连接再收服务器。
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

/** 建一个临时工作区，返回 { dir, cleanup }。 */
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-file-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('声明过的文件：按 cwd 解析相对路径，回原始字节与媒体类型', async (t) => {
  const dir = await workspace(t);
  const content = '第一行\nhello\n';
  await fs.mkdir(path.join(dir, 'out'));
  await fs.writeFile(path.join(dir, 'out', 'a.txt'), content, 'utf8');
  await fs.writeFile(path.join(dir, 'out', 'clip.mp4'), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));

  await withHost({ cwd: dir, events: [presented(1, ['out/a.txt'])] }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: 'out/a.txt' });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'text/plain; charset=utf-8');
    assert.equal(res.length, String(Buffer.byteLength(content)));
    assert.equal(res.bytes.toString('utf8'), content);
    assert.match(res.disposition, /filename="a\.txt"/);
  });

  await withHost({ cwd: dir, events: [presented(1, ['out/clip.mp4'])] }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: 'out/clip.mp4' });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'video/mp4');
    assert.deepEqual([...res.bytes], [0, 0, 0, 24, 102, 116, 121, 112]);
  });
});

test('工作区里的文件：不用交付声明也能取（正文里点的链接走这条）', async (t) => {
  const dir = await workspace(t);
  const content = '# 星尘笔记\n正文\n';
  await fs.mkdir(path.join(dir, 'test-docs'));
  await fs.writeFile(path.join(dir, 'test-docs', '说明.md'), content, 'utf8');
  // 一条声明都没有：放行只因为落点在工作区里；声明那一侧的历史一次都不该读。
  await withHost({ cwd: dir, events: [] }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: 'test-docs/说明.md' });
    assert.equal(res.status, 200);
    assert.equal(res.bytes.toString('utf8'), content);
    assert.equal(host.calls.history, 0);
  });
});

test('工作区外的一条都不给：403 outside-workspace，且一次盘都不碰', async (t) => {
  const dir = await workspace(t);
  // 工作区的**隔壁**：`../x/outside.txt` 与它的绝对路径写法都指向这里。
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-file-out-'));
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
  const outsideFile = path.join(outside, 'outside.txt');
  await fs.writeFile(outsideFile, 'nope', 'utf8');

  await withHost({ cwd: dir, events: [presented(1, ['out/a.txt'])] }, async (host) => {
    const escape = await host.post({ sessionId: 's1', path: `../${path.basename(outside)}/outside.txt` });
    assert.equal(escape.status, 403);
    assert.equal(escape.body.error.code, 'outside-workspace');
    const absolute = await host.post({ sessionId: 's1', path: outsideFile });
    assert.equal(absolute.status, 403);
    assert.equal(absolute.body.error.code, 'outside-workspace');
  });
});

test('声明过、盘上没有：404 missing', async (t) => {
  const dir = await workspace(t);
  await withHost({ cwd: dir, events: [presented(1, ['out/gone.png'])] }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: 'out/gone.png' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'missing');
  });
});

test('声明的是目录：400 not-a-file', async (t) => {
  const dir = await workspace(t);
  await fs.mkdir(path.join(dir, 'out'));
  await withHost({ cwd: dir, events: [presented(1, ['out'])] }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: 'out' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'not-a-file');
  });
});

test('绝对路径原样读', async (t) => {
  const dir = await workspace(t);
  const abs = path.join(dir, 'abs.pdf');
  await fs.writeFile(abs, '%PDF-1.4\n');
  // cwd 给一个不相干的目录：绝对路径不该被 cwd 影响。
  await withHost({ cwd: path.join(dir, 'nowhere'), events: [presented(1, [abs])] }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: abs });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'application/pdf');
  });
});

test('缺参数：400，不读历史', async () => {
  await withHost({ events: [] }, async (host) => {
    const res = await host.post({ sessionId: 's1' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad-request');
    assert.equal(host.calls.history, 0);
  });
});

test('读历史失败：502，不当成空清单', async () => {
  await withHost({ historyError: { code: 'boom', message: '宿主炸了' } }, async (host) => {
    const res = await host.post({ sessionId: 's1', path: 'x.txt' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'history-failed');
    assert.match(res.body.error.message, /宿主炸了/);
  });
});
