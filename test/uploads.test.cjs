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
 *  3. finish 之后暂存文件必须消失（改名而非复制），abort 必须把暂存删掉，否则
 *     `.staging` 会随每次失败上传一直涨。
 *  4. 认不出的 uploadId 一律 404，不能靠「新建一个空上传」蒙过去。
 *  5. 路由表必须真的挂上这四条，且 handler 模块被引入（接线漏了 App 必然 404）。
 *
 * 本测试驱动真实 handler（起真 http 服务、走真 req/res），只有收件根目录是临时目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleUploadBegin,
  handleUploadChunk,
  handleUploadFinish,
  handleUploadAbort,
  sanitizeName,
  CHUNK_BYTES,
} = require('../lib/mobile/uploads.js');
const { readWiring } = require('./lib/wiring.cjs');

/** 起一个只挂四条上传 handler 的真 http 服务；收件根目录指向临时目录。 */
async function serve(inbox) {
  process.env.DSH_MOBILE_INBOX = inbox;
  const server = http.createServer((req, res) => {
    const route = String(req.url || '').split('?')[0];
    const handler = {
      '/upload/begin': handleUploadBegin,
      '/upload/chunk': handleUploadChunk,
      '/upload/finish': handleUploadFinish,
      '/upload/abort': handleUploadAbort,
    }[route];
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    handler({}, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
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
    assert.equal((await api.post('/upload/finish', { uploadId })).status, 404);
  } finally {
    await api.close();
    fs.rmSync(inbox, { recursive: true, force: true });
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
