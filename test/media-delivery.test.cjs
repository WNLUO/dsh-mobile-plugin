'use strict';

/**
 * 媒体交付：生成任务登记、原件收存、失败重试与重启标记。
 *
 * 钉住协议里最要紧的几条：
 *  1. `begin` 立刻给出一条 `generating` 任务，并固定显示比例（App 靠它先占位、不再跳）。
 *  2. 收存一份**图片文件**后变 `ready`，尺寸/类型来自真实字节，不是调用方自报。
 *  3. 收存失败（来源 404）→ `failed`，但任务与来源留着，`retry` 能再收一次。
 *  4. 收存视频文件后 `kind` 必须是 video（与任务类型一致）。
 *  5. 插件重启时，未完成的 `generating`/`receiving` 任务落成 `interrupted`，不重跑生成。
 *  6. 取字节口只认已收存完成的原件，未完成的回 404。
 *
 * 起真 http 服务给取字节口用，收存来源用真临时文件 / 真本地 http。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createMediaService } = require('../lib/mobile/media/service.js');
const { mediaRoutes } = require('../lib/mobile/media/routes.js');
const { createMediaStore } = require('../lib/mobile/media/store.js');

const OWNER = { sessionId: 's1', turn: 1, anchorSeq: 5, cwd: undefined };

/** 一张 1x1 PNG。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');

async function tmpRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-media-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

function withService(t, root, options = {}) {
  const service = createMediaService({ root, fetch: options.fetch });
  t.after(() => service.close());
  return service;
}

test('begin 立刻给出固定比例的生成中任务', async (t) => {
  const root = await tmpRoot(t);
  const service = withService(t, root);
  const task = service.begin(OWNER, { kind: 'image', title: '一只猫', aspectRatio: '3:2' });
  assert.equal(task.phase, 'generating');
  assert.equal(task.kind, 'image');
  assert.equal(task.frameRatio, 1.5);
  assert.ok(task.id);
  // 同一 turn 同一 key 再来一次不产生第二条卡。
  const again = service.begin(OWNER, { kind: 'image', key: 'k1', title: 'a' });
  const dup = service.begin(OWNER, { kind: 'image', key: 'k1', title: 'b' });
  assert.equal(again.id, dup.id);
});

test('收存图片文件后 ready，尺寸取自真实字节', async (t) => {
  const root = await tmpRoot(t);
  const dir = await tmpRoot(t);
  const file = path.join(dir, 'cat.png');
  await fs.writeFile(file, PNG);
  const service = withService(t, root);
  const task = service.begin(OWNER, { kind: 'image' });
  const done = await service.receive(OWNER.sessionId, task.id, { path: file, cwd: dir });
  assert.equal(done.phase, 'ready');
  assert.equal(done.hasOriginal, true);
  assert.equal(done.mediaType, 'image/png');
  assert.equal(done.width, 1);
  assert.equal(done.height, 1);
});

test('收存失败 → failed，来源留着，retry 能再收一次', async (t) => {
  const root = await tmpRoot(t);
  const dir = await tmpRoot(t);
  // 第一发指向一个不存在的文件 → failed。
  const service = withService(t, root);
  const task = service.begin(OWNER, { kind: 'image' });
  await assert.rejects(() => service.receive(OWNER.sessionId, task.id, { path: path.join(dir, 'nope.png'), cwd: dir }));
  let current = service.get(OWNER.sessionId, task.id);
  assert.equal(current.phase, 'failed');
  // 把文件补上，retry 用同一份来源再收一次 → ready。
  const file = path.join(dir, 'nope.png');
  await fs.writeFile(file, PNG);
  const retried = await service.retry(OWNER.sessionId, task.id);
  assert.equal(retried.phase, 'ready');
});

test('收存视频文件 kind 必须是 video', async (t) => {
  const root = await tmpRoot(t);
  const dir = await tmpRoot(t);
  const file = path.join(dir, 'clip.mp4');
  // 最小可识别 mp4 头：size + 'ftyp'。
  await fs.writeFile(file, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(16)]));
  const service = withService(t, root);
  const task = service.begin(OWNER, { kind: 'video', aspectRatio: '16:9' });
  const done = await service.receive(OWNER.sessionId, task.id, { path: file, cwd: dir });
  assert.equal(done.phase, 'ready');
  assert.equal(done.mediaType, 'video/mp4');
});

test('重启把未完成的任务落成 interrupted', async (t) => {
  const root = await tmpRoot(t);
  const service = withService(t, root);
  const task = service.begin(OWNER, { kind: 'image' });
  assert.equal(service.get(OWNER.sessionId, task.id).phase, 'generating');
  // 新建一个 store 指向同一目录，模拟插件重启。
  const reopened = createMediaStore(root);
  const snapshot = reopened.read(OWNER.sessionId);
  const found = snapshot.items.find((item) => item.id === task.id);
  assert.equal(found.phase, 'interrupted');
});

test('取字节口只认已收存完成的原件；未完成回 404', async (t) => {
  const root = await tmpRoot(t);
  const dir = await tmpRoot(t);
  const file = path.join(dir, 'a.png');
  await fs.writeFile(file, PNG);
  const service = withService(t, root);
  const done = service.begin(OWNER, { kind: 'image' });
  const routes = mediaRoutes(service);
  const server = http.createServer((req, res) => {
    Promise.resolve(req.url.startsWith('/api/mobile/v1/media/file') ? routes.handleFile({}, req, res) : routes.handleTasks({}, req, res))
      .catch((error) => { if (!res.headersSent) { res.writeHead(500); res.end(String(error)); } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const notReady = await fetch(`${origin}/api/mobile/v1/media/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: OWNER.sessionId, taskId: done.id }) });
  assert.equal(notReady.status, 404);

  await service.receive(OWNER.sessionId, done.id, { path: file, cwd: dir });
  const ready = await fetch(`${origin}/api/mobile/v1/media/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: OWNER.sessionId, taskId: done.id }) });
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await ready.arrayBuffer());
  assert.deepEqual(bytes, PNG);
});
