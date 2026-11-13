'use strict';

/**
 * 移动端文件分片上传（POST /upload/begin、/upload/chunk、/upload/finish、/upload/abort）。
 *
 * 这条通道是「手机分享进来的文件怎么落到宿主机」的唯一出口：图片能进 session.send 的
 * base64 内容块，其它格式一律进不去。每条断言都对着一个真会出事的写法：
 *
 *  1. 文件名必须清成安全名 —— 手机侧的名字来自别的 App，带 `../`、斜杠、控制字符都
 *     可能，直接 join 就是往收件目录外写。落盘后必须仍带日期子目录。
 *  2. chunk 只吃「下一片」：跳号必须 409（否则会拼出一个静默缺段的文件），重复送达
 *     同一片按重传处理（回当前 received、不重复追加）—— 客户端因此不必先问进度。
 *  3. finish 之后暂存文件必须消失（同卷改名，跨卷复制后删除），abort 必须把暂存删掉，否则
 *     `.staging` 会随每次失败上传一直涨。
 *  4. 认不出的 uploadId 一律 404，不能靠「新建一个空上传」蒙过去。
 *  5. 路由表必须真的挂上这四条，且 handler 模块被引入（接线漏了 App 必然 404）。
 *  6. 带 `destPath` 时落点跟着它走（右栏的「传到这里」）：越界 403 且不留暂存残片、不是
 *     目录 400、重名照样加后缀；不带时行为与从前逐字相同 —— 仍进收件箱。
 *  7. 内联图片不按体积拒：超过 10MB 的图也得换成 base64 交出去，单张上限归桌面端管。
 *  8. 跨卷落盘仅在 EXDEV 时复制；暂停或慢落盘中的 finish 重试共用结果，不丢身份与暂存。
 *
 * 本测试驱动真实 handler（起真 http 服务、走真 req/res），只有收件根目录是临时目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const queue = require('../lib/mobile/project-write-queue.js');
const uploadHandlers = require('../lib/mobile/uploads.js');

const {
  handleUploadBegin,
  handleUploadChunk,
  handleUploadFinish,
  handleUploadAbort,
  sanitizeName,
  sweepExpiredUploads,
  sweepStaging,
  STAGING_TTL_MS,
  inlineUploadedImageBlocks,
  CHUNK_BYTES,
} = require('../lib/mobile/uploads.js');
const { readWiring } = require('./lib/wiring.cjs');

/**
 * 起一个只挂四条上传 handler 的真 http 服务；收件根目录指向临时目录。
 *
 * `options.workspaces` / `options.cwd` 是宿主那边的假清单：`destPath` 的允许区就按它判
 * （工作区 ∪ 会话项目目录，见 lib/mobile/allowed-zone.js）。
 */
async function serve(inbox, options = {}) {
  process.env.DSH_MOBILE_INBOX = inbox;
  const calls = { workspace: 0 };
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => {
          calls.workspace += 1;
          if (options.workspaceError) return { result: { ok: false, error: options.workspaceError } };
          return {
            result: {
              ok: true,
              value: { items: (options.workspaces || []).map((dir) => ({ workspaceId: 'w1', path: dir })) },
            },
          };
        },
      },
      sessions: {
        list: async () => ({
          result: { ok: true, value: { items: [{ sessionId: 's1', cwd: options.cwd ?? null }] } },
        }),
      },
    },
  };
  const server = http.createServer((req, res) => {
    const route = String(req.url || '').split('?')[0];
    const handler = {
      '/upload/begin': (options.handlers || uploadHandlers).handleUploadBegin,
      '/upload/chunk': (options.handlers || uploadHandlers).handleUploadChunk,
      '/upload/finish': (options.handlers || uploadHandlers).handleUploadFinish,
      '/upload/abort': (options.handlers || uploadHandlers).handleUploadAbort,
    }[route];
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    if (options.onBody) req.on('end', () => { setImmediate(() => options.onBody(route)); });
    handler(ctx, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    post: async (route, body) => {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function tempInbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upload-'));
}

/** 建一个临时目录（工作区 / 落点 / 隔壁），用例结束时删掉。 */
function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** 把一段文本按片大小切成若干片，返回 base64 片数组。 */
function chunksOf(text, size) {
  const bytes = Buffer.from(text, 'utf8');
  const out = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    out.push(bytes.subarray(offset, offset + size).toString('base64'));
  }
  return out;
}

test('分片上传：begin → chunk → finish 落盘成收件目录下的真文件', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const begin = await api.post('/upload/begin', { name: '会议记录.txt' });
    assert.equal(begin.status, 200);
    assert.equal(begin.body.ok, true);
    assert.equal(begin.body.chunkSize, CHUNK_BYTES);
    const uploadId = begin.body.uploadId;
    assert.match(uploadId, /^[0-9a-f-]{36}$/);

    const parts = chunksOf('第一段\n第二段\n第三段\n', 6);
    for (let index = 0; index < parts.length; index += 1) {
      const chunk = await api.post('/upload/chunk', { uploadId, index, data: parts[index] });
      assert.equal(chunk.status, 200);
      assert.equal(chunk.body.received, index + 1);
    }

    const finish = await api.post('/upload/finish', { uploadId });
    assert.equal(finish.status, 200);
    assert.equal(finish.body.ok, true);
    assert.equal(finish.body.bytes, Buffer.byteLength('第一段\n第二段\n第三段\n'));
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), '第一段\n第二段\n第三段\n');

    // 落点是 <收件根>/<日期>/<文件名>，且暂存残片已随改名消失。
    const rel = path.relative(inbox, finish.body.path).split(path.sep);
    assert.equal(rel.length, 2);
    assert.match(rel[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rel[1], '会议记录.txt');
    assert.deepEqual(fs.readdirSync(path.join(inbox, '.staging')), []);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
  }
});

test('文件名清成安全名：路径成分、控制字符、前导点与超长都折干净', async () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('..\\..\\windows\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeName('报告\u0000\u001b[31m.pdf'), '报告__[31m.pdf');
  assert.equal(sanitizeName('.hidden'), 'hidden');
  assert.equal(sanitizeName('   '), '未命名文件');
  assert.equal(sanitizeName(''), '未命名文件');
  const long = 'x'.repeat(300) + '.pdf';
  assert.equal(sanitizeName(long).length, 120);
  assert.ok(sanitizeName(long).endsWith('.pdf'));

  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const begin = await api.post('/upload/begin', { name: '../../.ssh/authorized_keys' });
    const uploadId = begin.body.uploadId;
    await api.post('/upload/chunk', { uploadId, index: 0, data: Buffer.from('x').toString('base64') });
    const finish = await api.post('/upload/finish', { uploadId });
    assert.equal(path.basename(finish.body.path), 'authorized_keys');
    // 落点必须在收件根里，不能因为名字里的路径成分跑到外面去。
    assert.ok(finish.body.path.startsWith(inbox + path.sep));
    assert.equal(path.relative(inbox, finish.body.path).split(path.sep).length, 2);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
  }
});

test('重名不覆盖：同一天传两个同名文件，第二个自动加后缀', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  const uploadOnce = async (name, text) => {
    const begin = await api.post('/upload/begin', { name });
    await api.post('/upload/chunk', {
      uploadId: begin.body.uploadId,
      index: 0,
      data: Buffer.from(text, 'utf8').toString('base64'),
    });
    return api.post('/upload/finish', { uploadId: begin.body.uploadId });
  };
  try {
    const first = await uploadOnce('方案.pdf', 'A');
    const second = await uploadOnce('方案.pdf', 'B');
    assert.notEqual(first.body.path, second.body.path);
    assert.equal(path.basename(first.body.path), '方案.pdf');
    assert.equal(path.basename(second.body.path), '方案-1.pdf');
    assert.equal(fs.readFileSync(first.body.path, 'utf8'), 'A');
    assert.equal(fs.readFileSync(second.body.path, 'utf8'), 'B');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
  }
});

test('chunk 顺序与幂等：跳号 409、重传同一片回当前进度、内容不重复追加', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const begin = await api.post('/upload/begin', { name: 'a.txt' });
    const uploadId = begin.body.uploadId;
    const first = Buffer.from('AAA').toString('base64');
    const second = Buffer.from('BBB').toString('base64');

    assert.equal((await api.post('/upload/chunk', { uploadId, index: 1, data: second })).status, 409);
    assert.equal((await api.post('/upload/chunk', { uploadId, index: 0, data: first })).body.received, 1);
    // 重传第 0 片：回 200 且进度不变，且不会再追加一遍。
    const retry = await api.post('/upload/chunk', { uploadId, index: 0, data: first });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.received, 1);
    assert.equal((await api.post('/upload/chunk', { uploadId, index: 1, data: second })).body.received, 2);

    const finish = await api.post('/upload/finish', { uploadId });
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), 'AAABBB');

    assert.equal((await api.post('/upload/chunk', { uploadId, index: 2, data: first })).status, 404);
    // 再收一次同一个 uploadId：回放第一次的结果，不 404、也不在收件目录里多落一份。
    const replay = await api.post('/upload/finish', { uploadId });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.path, finish.body.path);
    assert.equal(replay.body.bytes, finish.body.bytes);
    assert.equal(fs.readdirSync(path.dirname(finish.body.path)).length, 1);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
  }
});

test('收口回放只对已落盘的 uploadId 生效：从没见过的 id 与放弃过的上传仍然 404', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    assert.equal((await api.post('/upload/finish', { uploadId: 'never-seen' })).status, 404);
    assert.equal((await api.post('/upload/finish', {})).status, 404);

    const begin = await api.post('/upload/begin', { name: 'half.bin' });
    await api.post('/upload/chunk', {
      uploadId: begin.body.uploadId,
      index: 0,
      data: Buffer.from('x').toString('base64'),
    });
    await api.post('/upload/abort', { uploadId: begin.body.uploadId });
    assert.equal((await api.post('/upload/finish', { uploadId: begin.body.uploadId })).status, 404);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('放弃的上传过期后清除内存记录和暂存文件', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    const begin = await api.post('/upload/begin', { name: 'abandoned.bin' });
    const uploadId = begin.body.uploadId;
    const staging = path.join(inbox, '.staging', `${uploadId}.part`);
    assert.equal(fs.existsSync(staging), true);

    // 模拟 TTL 已过，避免测试实际等待。
    await sweepExpiredUploads(Date.now() + STAGING_TTL_MS + 1000);
    assert.equal(fs.existsSync(staging), false);
    assert.equal((await api.post('/upload/chunk', {
      uploadId,
      index: 0,
      data: Buffer.from('x').toString('base64'),
    })).status, 404);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('内联图片不按体积拒：超过旧 10MB 门槛的图照样换成 base64 交给宿主', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    // 11MB：手机侧照着桌面端的 20MB 附件上限放行，插件这边不该再拦一道。
    const image = Buffer.alloc(11 * 1024 * 1024);
    for (let i = 0; i < image.length; i += 1) image[i] = (i * 31 + 7) & 0xff;

    const begin = await api.post('/upload/begin', { name: 'big.png' });
    const step = 6 * 1024 * 1024;
    let index = 0;
    for (let offset = 0; offset < image.length; offset += step) {
      const chunk = await api.post('/upload/chunk', {
        uploadId: begin.body.uploadId,
        index,
        data: image.subarray(offset, offset + step).toString('base64'),
      });
      assert.equal(chunk.status, 200);
      index += 1;
    }
    const finish = await api.post('/upload/finish', { uploadId: begin.body.uploadId });
    assert.equal(finish.body.bytes, image.length);

    const content = [{ type: 'image', mediaType: 'image/png', uploadId: begin.body.uploadId }];
    assert.equal(await inlineUploadedImageBlocks(content), null);
    assert.equal(content[0].data, image.toString('base64'));
    assert.equal(content[0].name, 'big.png');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('abort 删掉暂存残片；畸形入参一律 400 且不建暂存', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox);
  try {
    assert.equal((await api.post('/upload/begin', {})).status, 400);
    assert.equal((await api.post('/upload/begin', { name: '   ' })).status, 400);
    assert.equal((await api.post('/upload/begin', 'not json')).status, 400);

    const begin = await api.post('/upload/begin', { name: 'b.bin' });
    const uploadId = begin.body.uploadId;
    assert.equal((await api.post('/upload/chunk', { uploadId, index: 0 })).status, 400);
    assert.equal((await api.post('/upload/chunk', { uploadId, index: -1, data: '' })).status, 400);
    assert.equal(
      (await api.post('/upload/chunk', { uploadId, index: 0, data: '!!!not-base64!!!' })).status,
      400,
    );

    await api.post('/upload/chunk', { uploadId, index: 0, data: Buffer.from('x').toString('base64') });
    assert.equal(fs.readdirSync(path.join(inbox, '.staging')).length, 1);
    assert.equal((await api.post('/upload/abort', { uploadId })).status, 200);
    assert.deepEqual(fs.readdirSync(path.join(inbox, '.staging')), []);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

/** 一次完整的上传：begin（可带 destPath / sessionId）→ 一片 → finish。 */
async function uploadOnce(api, body, text) {
  const begin = await api.post('/upload/begin', body);
  if (begin.status !== 200) return { begin, finish: null };
  await api.post('/upload/chunk', {
    uploadId: begin.body.uploadId,
    index: 0,
    data: Buffer.from(text, 'utf8').toString('base64'),
  });
  return { begin, finish: await api.post('/upload/finish', { uploadId: begin.body.uploadId }) };
}

test('destPath：落进指定目录，收件箱一个字节都不落', async (t) => {
  const inbox = tempInbox();
  const dest = tempDir(t, 'dsh-upload-dest-');
  const api = await serve(inbox, { workspaces: [dest] });
  try {
    const { begin, finish } = await uploadOnce(api, { name: '会议记录.txt', destPath: dest }, '第一段\n');
    assert.equal(begin.status, 200);
    assert.equal(finish.status, 200);
    // 回执里的 path 就是最终落点（App 拿它写 @提及、弹「已存到」）。
    assert.equal(finish.body.path, path.join(dest, '会议记录.txt'));
    assert.equal(finish.body.name, '会议记录.txt');
    assert.equal(finish.body.bytes, Buffer.byteLength('第一段\n'));
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), '第一段\n');
    // 收件箱那边只剩 .staging，没有按日期分的目录。
    assert.deepEqual(fs.readdirSync(inbox), ['.staging']);
    assert.deepEqual(fs.readdirSync(path.join(inbox, '.staging')), []);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('destPath 越界：403 outside-allowed，且连暂存都不建', async (t) => {
  const inbox = tempInbox();
  const ws = tempDir(t, 'dsh-upload-ws-');
  const outside = tempDir(t, 'dsh-upload-out-');
  const api = await serve(inbox, { workspaces: [ws] });
  try {
    const begin = await api.post('/upload/begin', { name: 'a.txt', destPath: outside });
    assert.equal(begin.status, 403);
    assert.equal(begin.body.error.code, 'outside-allowed');
    assert.equal(api.calls.workspace, 1, '越界判定要问过宿主的工作区清单');
    // 拒得早：一个暂存残片都不该留下（残片要躺满 7 天才清）。
    assert.equal(fs.existsSync(path.join(inbox, '.staging')), false);

    // 名字只是**以工作区路径为前缀**的隔壁目录也不认。
    const sibling = await api.post('/upload/begin', { name: 'a.txt', destPath: `${ws}-evil` });
    assert.equal(sibling.status, 403);
    assert.equal(sibling.body.error.code, 'outside-allowed');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('destPath 不是目录、不存在或不是绝对路径：400', async (t) => {
  const inbox = tempInbox();
  const ws = tempDir(t, 'dsh-upload-ws-');
  fs.writeFileSync(path.join(ws, 'file.txt'), 'x');
  const api = await serve(inbox, { workspaces: [ws] });
  try {
    const onFile = await api.post('/upload/begin', { name: 'a.txt', destPath: path.join(ws, 'file.txt') });
    assert.equal(onFile.status, 400);
    assert.equal(onFile.body.error.code, 'not-a-directory');

    const gone = await api.post('/upload/begin', { name: 'a.txt', destPath: path.join(ws, 'nope') });
    assert.equal(gone.status, 400);
    assert.equal(gone.body.error.code, 'not-a-directory');

    // 相对路径没有可信基准：直接 400，连宿主都不问。
    const before = api.calls.workspace;
    const relative = await api.post('/upload/begin', { name: 'a.txt', destPath: 'sub/dir' });
    assert.equal(relative.status, 400);
    assert.equal(relative.body.error.code, 'bad-request');
    assert.equal(api.calls.workspace, before);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('destPath 重名不覆盖：同目录里第二个自动加后缀', async (t) => {
  const inbox = tempInbox();
  const dest = tempDir(t, 'dsh-upload-dest-');
  const api = await serve(inbox, { workspaces: [dest] });
  try {
    const first = await uploadOnce(api, { name: '方案.pdf', destPath: dest }, 'A');
    const second = await uploadOnce(api, { name: '方案.pdf', destPath: dest }, 'B');
    assert.equal(path.basename(first.finish.body.path), '方案.pdf');
    assert.equal(path.basename(second.finish.body.path), '方案-1.pdf');
    assert.equal(fs.readFileSync(first.finish.body.path, 'utf8'), 'A');
    assert.equal(fs.readFileSync(second.finish.body.path, 'utf8'), 'B');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('destPath 在会话的项目目录里：带了 sessionId 才放行', async (t) => {
  const inbox = tempInbox();
  const cwd = tempDir(t, 'dsh-upload-cwd-');
  const ws = tempDir(t, 'dsh-upload-ws-');
  const api = await serve(inbox, { workspaces: [ws], cwd });
  try {
    // cwd 没登记成工作区：不带 sessionId 时它就在允许区之外。
    const narrow = await api.post('/upload/begin', { name: 'main.c', destPath: cwd });
    assert.equal(narrow.status, 403);
    assert.equal(narrow.body.error.code, 'outside-allowed');

    const { finish } = await uploadOnce(api, { name: 'main.c', destPath: cwd, sessionId: 's1' }, 'int main;');
    assert.equal(finish.status, 200);
    assert.equal(finish.body.path, path.join(cwd, 'main.c'));
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), 'int main;');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

test('不带 destPath：仍落进收件箱，begin 的回执形状一个字没变', async () => {
  const inbox = tempInbox();
  const api = await serve(inbox, { workspaces: [] });
  try {
    const { begin, finish } = await uploadOnce(api, { name: 'share.txt' }, '正文');
    assert.equal(begin.status, 200);
    assert.deepEqual(Object.keys(begin.body).sort(), ['chunkSize', 'maxChunkSize', 'ok', 'uploadId']);
    assert.equal(api.calls.workspace, 0, '不带 destPath 不该为了判范围去问宿主');
    assert.equal(path.relative(inbox, finish.body.path).split(path.sep).length, 2);
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), '正文');
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    delete process.env.DSH_MOBILE_INBOX;
  }
});

/** 与历史测试一样运行真实模块；只在内存里替换源码，用同一行为断言杀掉关键变异。 */
function changedUploads(from, to) {
  const filename = require.resolve('../lib/mobile/uploads.js');
  const source = fs.readFileSync(filename, 'utf8');
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, '变异必须真的替换到实现');
  const module = { exports: {} };
  vm.runInNewContext(changed, {
    module, exports: module.exports, require: createRequire(filename), Buffer, process, setTimeout, clearTimeout,
  }, { filename });
  return module.exports;
}

async function crossVolumeScenario(t, handlers = uploadHandlers, code = 'EXDEV') {
  const inbox = tempDir(t, 'dsh-upload-cross-inbox-');
  const dest = tempDir(t, 'dsh-upload-cross-dest-');
  fs.writeFileSync(path.join(dest, '跨卷.txt'), '原文件');
  const rename = fsp.rename;
  const copyFile = fsp.copyFile;
  let copies = 0;
  fsp.rename = async (source, target) => {
    if (source.startsWith(inbox + path.sep) && target.startsWith(dest + path.sep)) {
      throw Object.assign(new Error(code), { code });
    }
    return rename(source, target);
  };
  fsp.copyFile = async (...args) => { copies += 1; return copyFile(...args); };
  const api = await serve(inbox, { workspaces: [dest], handlers });
  try {
    const { finish } = await uploadOnce(api, { name: '跨卷.txt', destPath: dest }, '新文件');
    if (code !== 'EXDEV') {
      assert.equal(finish.status, 500);
      assert.equal(copies, 0, '其它落盘失败不能绕过原错误去复制');
      assert.equal(fs.existsSync(path.join(dest, '跨卷-1.txt')), false);
      return;
    }
    assert.equal(finish.status, 200, 'EXDEV 必须改用复制完成上传');
    assert.equal(copies, 1);
    assert.equal(finish.body.path, path.join(dest, '跨卷-1.txt'));
    assert.equal(fs.readFileSync(path.join(dest, '跨卷.txt'), 'utf8'), '原文件');
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), '新文件');
    assert.deepEqual(fs.readdirSync(path.join(inbox, '.staging')), [], '复制成功后才清暂存');
  } finally {
    await api.close();
    fsp.rename = rename;
    fsp.copyFile = copyFile;
    delete process.env.DSH_MOBILE_INBOX;
  }
}

test('destPath 跨卷：EXDEV 复制后清暂存，重名不覆盖；其它错误不复制', async (t) => {
  await crossVolumeScenario(t);
  await crossVolumeScenario(t, uploadHandlers, 'EACCES');
});

test('变异：移除 EXDEV 复制后，同一跨卷落盘断言必须失败', async (t) => {
  const mutant = changedUploads("if (error.code !== 'EXDEV') throw error;", 'throw error;');
  await assert.rejects(() => crossVolumeScenario(t, mutant), /EXDEV 必须改用复制/);
});

async function pausedFinishScenario(t, handlers = uploadHandlers) {
  const inbox = tempDir(t, 'dsh-upload-paused-inbox-');
  const dest = tempDir(t, 'dsh-upload-paused-dest-');
  let finishCount = 0;
  const arrivals = [];
  const arrived = (count) => new Promise((resolve) => {
    if (finishCount >= count) resolve();
    else arrivals.push({ count, resolve });
  });
  const api = await serve(inbox, {
    workspaces: [dest], handlers,
    onBody: (route) => {
      if (route !== '/upload/finish') return;
      finishCount += 1;
      for (const item of arrivals) if (finishCount >= item.count) item.resolve();
    },
  });
  let first;
  let second;
  try {
    const begin = await api.post('/upload/begin', { name: '暂停.txt', destPath: dest });
    const uploadId = begin.body.uploadId;
    await api.post('/upload/chunk', { uploadId, index: 0, data: Buffer.from('只落一份').toString('base64') });
    const staging = path.join(inbox, '.staging', `${uploadId}.part`);
    queue.pauseProjectWrites(dest);
    const controller = new AbortController();
    first = fetch(api.base + '/upload/finish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId }), signal: controller.signal,
    }).then(() => null, (error) => error.name);
    await arrived(1);
    controller.abort();
    assert.equal(await first, 'AbortError', '首个超时连接退出，不能绑住后续回包');
    second = api.post('/upload/finish', { uploadId });
    await arrived(2);
    // 排队期间两种过期清理都不能带走 finish 正在使用的片。
    const old = new Date(Date.now() - STAGING_TTL_MS - 1000);
    fs.utimesSync(staging, old, old);
    await handlers.sweepExpiredUploads(Date.now() + STAGING_TTL_MS + 1000);
    const swept = await handlers.sweepStaging(path.join(inbox, '.staging'));
    assert.equal(swept.deleted, 0, '磁盘清扫不能删正在收口的片');
    assert.equal(fs.existsSync(staging), true);
    assert.equal((await api.post('/upload/abort', { uploadId })).status, 200);
    assert.equal(fs.existsSync(staging), true, '收口已被接受，abort 不能与落盘争用暂存');
    assert.equal((await api.post('/upload/chunk', { uploadId, index: 1, data: 'WA==' })).status, 404);
    queue.resumeProjectWrites(dest);
    const finish = await second;
    assert.equal(finish.status, 200, '排队期间的 finish 重试必须共用完成结果');
    const replay = await api.post('/upload/finish', { uploadId });
    assert.equal(replay.body.path, finish.body.path);
    assert.equal(fs.readFileSync(finish.body.path, 'utf8'), '只落一份');
    assert.deepEqual(fs.readdirSync(dest), ['暂停.txt']);
    assert.deepEqual(fs.readdirSync(path.join(inbox, '.staging')), []);
  } finally {
    queue.resumeProjectWrites(dest);
    await Promise.allSettled([first, second].filter(Boolean));
    await api.close();
    delete process.env.DSH_MOBILE_INBOX;
  }
}

test('暂停 finish：首连接断开后重试共用落盘，abort 和过期清扫不抢暂存', async (t) => {
  await pausedFinishScenario(t);
});

test('变异：finish 入队前摘掉上传身份，同一暂停重试断言必须失败', async (t) => {
  const mutant = changedUploads('if (!job.finishPromise) {', 'if (!job.finishPromise) {\n    removeUpload(uploadId, job);');
  await assert.rejects(() => pausedFinishScenario(t, mutant), /磁盘清扫不能删正在收口的片|排队期间的 finish 重试必须共用完成结果|ENOENT/);
});

test('路由接线：四条端点挂在移动端路由表上，且引入了 handler 模块', () => {
  const wiring = readWiring();
  for (const route of [
    "route('/api/mobile/v1/upload/begin', uploads.handleUploadBegin)",
    "route('/api/mobile/v1/upload/chunk', uploads.handleUploadChunk)",
    "route('/api/mobile/v1/upload/finish', uploads.handleUploadFinish)",
    "route('/api/mobile/v1/upload/abort', uploads.handleUploadAbort)",
  ]) {
    assert.ok(wiring.includes(route), `路由表缺少 ${route}`);
  }
  assert.match(wiring, /require\(['"](?:\.\.?\/mobile)\/uploads\.js['"]\)/);
});
