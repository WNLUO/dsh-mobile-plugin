'use strict';
// 正文图的取字节口（`POST /api/mobile/v1/session/local-image`）与两侧契约。
//
// 这条口存在的全部意义是「不扩能力面」：正文里那张图在投影历史时被登记成一个短编号，
// 手机拿着编号来取字节。**它不是按路径读文件** —— 构造任何一个没登记过的编号都取不到东西。
//
// 钉三层：
//  1. 纯函数：登记 → 编号稳定、宽高从文件头读出来、数量上限生效；
//  2. 取图口：只认登记表，没登记的回 404（不是回一个别的文件）；
//  3. 契约：插件路由表与 App 路径常量两边同一条路径，编号前缀两边同一个。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inlineTextImages, localImageOf, registerLocalImage, imageSizeOf, clearLocalImages,
} = require('../lib/mobile/local-images.js');
const { handleSessionLocalImage } = require('../lib/mobile/session-local-image.js');

/**
 * App 侧那两张表只在整仓检出里存在：插件被单独 clone 出去（公开发布仓库）时主仓的 `app/`
 * 不在，那条流水线跑的是发出去的包本身。判据是文件在不在，整仓检出里缺了照样红。
 */
const APP_PATHS = path.join(__dirname, '../../app/src/services/viewmodels/apiPaths.ts');
const APP_IMAGE_URLS = path.join(__dirname, '../../app/src/utils/markdown/imageUrls.ts');
const SKIP_NO_APP = !fs.existsSync(APP_PATHS) && `${APP_PATHS} 不存在（插件单独检出），跳过跨仓对账`;

/** 造一张只有文件头、尺寸字段是真的假 PNG（宽 3 高 2）。 */
function fakePng(width = 3, height = 2) {
  const buf = Buffer.alloc(32);
  buf[0] = 0x89;
  buf.write('PNG', 1, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-image-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 假响应：把 handler 吐出来的东西收下来（够用就行，别引整套 http 夹具）。 */
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    setHeader() {},
    end(text) { this.body = JSON.parse(text); },
    writeHead(code) { this.statusCode = code; },
  };
}

/** 假请求：`readJsonBody` 认 `req.body` 已经解析好的那种形状（项目里现成做法）。 */
function fakeReq(body) {
  return { method: 'POST', headers: {}, body };
}

test('登记：同一张图重复登记是同一个编号，宽高从文件头读出来', () => withTempDir(async (dir) => {
  clearLocalImages();
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, fakePng(3, 2));
  const first = await registerLocalImage(file);
  const second = await registerLocalImage(file);
  assert.ok(first && first.id);
  assert.equal(first.id, second.id, '同一份文件反复投影不该每次换号');
  assert.deepEqual({ width: first.width, height: first.height }, { width: 3, height: 2 });
  assert.equal(first.mediaType, 'image/png');
  assert.ok(localImageOf(first.id), '登记完要能按编号查回来');
}));

test('登记：不是位图 / 不存在 / 太大一律不登记（正文保持字面 markdown）', () => withTempDir(async (dir) => {
  clearLocalImages();
  const notImage = path.join(dir, 'x.png');
  fs.writeFileSync(notImage, Buffer.from('#!/bin/sh\n'));
  assert.equal(await registerLocalImage(notImage), null, '字节不是位图就不能登记');
  assert.equal(await registerLocalImage(path.join(dir, 'missing.png')), null);
  const huge = path.join(dir, 'huge.png');
  fs.writeFileSync(huge, Buffer.concat([fakePng(), Buffer.alloc(3 * 1024 * 1024)]));
  assert.equal(await registerLocalImage(huge), null, '超过 2.5MB 的不登记');
}));

test('文件头里的宽高不合理时不写进正文（垃圾数据不许撑坏行高）', () => withTempDir(async (dir) => {
  clearLocalImages();
  const junk = Buffer.alloc(32);
  junk[0] = 0x89;
  junk.write('PNG', 1, 'latin1');
  junk.writeUInt32BE(0x7fffffff, 16);
  junk.writeUInt32BE(0x7fffffff, 20);
  assert.equal(imageSizeOf(junk).width, 0x7fffffff, '解析本身照实读出来');
  const file = path.join(dir, 'junk.png');
  fs.writeFileSync(file, junk);
  const entry = await registerLocalImage(file);
  assert.ok(entry, '仍然是张位图，编号照给');
  assert.equal(entry.width, undefined, '但不合理的宽高不许写进登记项');
  assert.equal(entry.height, undefined);
}));

test('取图口：没登记过的编号回 404，绝不读别的文件', async () => {
  clearLocalImages();
  const res = fakeRes();
  await handleSessionLocalImage({}, fakeReq({ id: '../../etc/passwd' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'not-found');
});

test('取图口：缺 id 回 400', async () => {
  const res = fakeRes();
  await handleSessionLocalImage({}, fakeReq({}), res);
  assert.equal(res.statusCode, 400);
});

test('取图口：登记过的编号回字节与宽高', () => withTempDir(async (dir) => {
  clearLocalImages();
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, fakePng(3, 2));
  const entry = await registerLocalImage(file);
  const res = fakeRes();
  await handleSessionLocalImage({}, fakeReq({ id: entry.id }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mediaType, 'image/png');
  assert.equal(res.body.width, 3);
  assert.equal(res.body.data, fs.readFileSync(file).toString('base64'));
}));

test('正文产出与取图口对得上：正文里的编号一定能取回字节', () => withTempDir(async (dir) => {
  clearLocalImages();
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, fakePng(4, 5));
  const text = await inlineTextImages(`看图 ![](${file}) 完`);
  const m = /!\[\]\(dsh-local-image:([a-f0-9]+)\?w=(\d+)&h=(\d+)\)/.exec(text);
  assert.ok(m, text);
  assert.equal(m[2], '4');
  assert.equal(m[3], '5');
  const res = fakeRes();
  await handleSessionLocalImage({}, fakeReq({ id: m[1] }), res);
  assert.equal(res.statusCode, 200, '正文里出现的编号必须取得到');
}));

test('两侧契约：路由表、路径常量、编号前缀三处同一个形状', { skip: SKIP_NO_APP }, () => {
  const routes = fs.readFileSync(path.join(__dirname, '../lib/routes/mobile-api.js'), 'utf8');
  assert.ok(routes.includes("'/api/mobile/v1/session/local-image'"), '插件路由表要注册这条');
  const appPaths = fs.readFileSync(APP_PATHS, 'utf8');
  assert.ok(appPaths.includes("sessionLocalImage: '/session/local-image'"), 'App 路径常量要同名');
  const appUrls = fs.readFileSync(APP_IMAGE_URLS, 'utf8');
  assert.ok(appUrls.includes('dsh-local-image:'), 'App 要认这个前缀');
});
