'use strict';

/**
 * 收件目录（`~/.dsh/mobile-inbox`）的按龄清理：`lib/mobile/inbox-clean.js`。
 *
 * 备这条守卫的理由是这条通道**只进不出**：手机分享进来的文件落盘之后，归档会话、删掉会话
 * 都带不走它们（落盘的名字里没有任何会话身份），唯一的出口就是这里。所以这里要钉住的是
 * 「什么该删、什么绝对不能删」这一条边界：
 *
 *  1. 满保留期的删、不满的一天都不碰 —— 正在跑的那一回合可能要读；
 *  2. 删的是**文件**不是日期目录：目录按上传那天分堆，整段删会把才放了两小时的一起带走；
 *  3. `.staging` 与别的非日期目录一个都不许碰（暂存残片归 uploads.js 自己的 TTL）；
 *  4. 空下来的日期目录顺手收掉，还留着文件的留着；
 *  5. 占用读数与清理用的是同一套判据，界面显示「可清理 N 个」就真的会删那 N 个；
 *  6. 两条路由真的挂上了（接线漏了 App 与面板必然 404）。
 *
 * 收件根目录用临时目录（`DSH_MOBILE_INBOX`），不碰本机真的那份。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scanInbox,
  clearInbox,
  clearInboxOnce,
  autoClearEnabled,
  setAutoClear,
  INBOX_KEEP_MS,
} = require('../lib/mobile/inbox-clean.js');
const { readRouteTable } = require('./lib/wiring.cjs');

/** 一个临时收件根；测试结束顺手删掉。每个用例都把自动清理关掉、DSH_HOME 指到临时目录。 */
function makeInbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inbox-'));
  process.env.DSH_MOBILE_INBOX = root;
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  setAutoClear(false);
  // clearInboxOnce 每进程只跑一次，跨用例要清掉那个标记。
  globalThis[Symbol.for('dsh-mobile-plugin.inbox-cleared-once')] = undefined;
  return root;
}

/** 造一份「落盘于 ageMs 之前」的文件；mtime 是这里唯一的判据，所以要真的改它。 */
function writeFile(root, dir, name, bytes, ageMs) {
  const target = path.join(root, dir);
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, at, at);
  return file;
}

const HOUR = 60 * 60 * 1000;

test('保留期就是 24 小时', () => {
  assert.equal(INBOX_KEEP_MS, 24 * HOUR);
});

test('满保留期的才算可清理，不满的一天都不碰', async () => {
  const root = makeInbox();
  writeFile(root, '2026-10-20', 'old.zip', 1000, 30 * HOUR);
  writeFile(root, '2026-10-21', 'fresh.zip', 500, 2 * HOUR);
  const scan = await scanInbox();
  assert.equal(scan.files, 2);
  assert.equal(scan.bytes, 1500);
  assert.equal(scan.deletableFiles, 1, '只有 30 小时那份够龄');
  assert.equal(scan.deletableBytes, 1000);

  const result = await clearInbox();
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.freedBytes, 1000);
  assert.equal(result.failedFiles, 0);
  // 刚传的那份必须还在：那一回合的助手可能正在读它。
  assert.ok(fs.existsSync(path.join(root, '2026-10-21', 'fresh.zip')), '不满保留期的文件被误删了');
  assert.ok(!fs.existsSync(path.join(root, '2026-10-20', 'old.zip')));
});

test('删的是文件不是日期目录：同一天里新旧混着时只删旧的那份', async () => {
  const root = makeInbox();
  writeFile(root, '2026-10-21', 'morning.zip', 700, 26 * HOUR);
  writeFile(root, '2026-10-21', 'evening.zip', 300, 1 * HOUR);
  await clearInbox();
  assert.ok(!fs.existsSync(path.join(root, '2026-10-21', 'morning.zip')));
  assert.ok(fs.existsSync(path.join(root, '2026-10-21', 'evening.zip')), '整段删日期目录会把才放一小时的一起带走');
});

test('清空的日期目录收掉，还有文件的留着', async () => {
  const root = makeInbox();
  writeFile(root, '2026-10-18', 'a.zip', 10, 50 * HOUR);
  writeFile(root, '2026-10-19', 'b.zip', 10, 40 * HOUR);
  writeFile(root, '2026-10-19', 'c.zip', 10, 1 * HOUR);
  await clearInbox();
  assert.ok(!fs.existsSync(path.join(root, '2026-10-18')), '空了就该收掉');
  assert.ok(fs.existsSync(path.join(root, '2026-10-19')), '还有今天那份，目录不能删');
});

test('.staging 里够龄的残片要清（它只在 begin 时扫，没人上传就一直躺着）', async () => {
  const root = makeInbox();
  writeFile(root, '.staging', 'stale.part', 12 * 1024 * 1024, 50 * HOUR);
  writeFile(root, '.staging', 'fresh.part', 4000, 1 * HOUR);
  const scan = await scanInbox();
  assert.equal(scan.stagingFiles, 2, '残片要并进同一份读数');
  assert.equal(scan.bytes, 12 * 1024 * 1024 + 4000);
  const result = await clearInbox();
  assert.equal(result.deletedFiles, 1, '只清够龄的那一份');
  assert.equal(result.freedBytes, 12 * 1024 * 1024);
  assert.ok(!fs.existsSync(path.join(root, '.staging', 'stale.part')), '睡了几天的残片必须清掉');
  assert.ok(fs.existsSync(path.join(root, '.staging', 'fresh.part')), '正在传的那一份不能碰');
});

test('任何非日期目录都不进统计、也不许碰', async () => {
  const root = makeInbox();
  writeFile(root, 'notes', 'readme.txt', 4000, 50 * HOUR);
  const scan = await scanInbox();
  assert.equal(scan.files, 0, '日期堆之外的东西不进统计');
  assert.equal(scan.stagingFiles, 0);
  const result = await clearInbox();
  assert.equal(result.deletedFiles, 0);
  assert.ok(fs.existsSync(path.join(root, 'notes', 'readme.txt')));
});

test('收件根不存在时什么都不做、也不抛', async () => {
  process.env.DSH_MOBILE_INBOX = path.join(os.tmpdir(), 'dsh-inbox-missing-xyz');
  const scan = await scanInbox();
  assert.deepEqual({ files: scan.files, bytes: scan.bytes, deletableFiles: scan.deletableFiles }, { files: 0, bytes: 0, deletableFiles: 0 });
  const result = await clearInbox();
  assert.equal(result.deletedFiles, 0);
});

test('残片的读数与清理也是同一套判据：报「可清理 N」就真的删掉那 N 个', async () => {
  const root = makeInbox();
  writeFile(root, '.staging', 'old.part', 3000, 30 * HOUR);
  writeFile(root, '.staging', 'new.part', 3000, 2 * HOUR);
  const before = await scanInbox();
  assert.equal(before.stagingFiles, 2);
  assert.equal(before.deletableFiles, 1, '刚传的那一份（2 小时）不算可清理');
  const result = await clearInbox();
  // 读那份的 cutoff 与真正删时用的 sweepStaging 必须是同一个 TTL（都来自 uploads.js）。
  // 两处各写一个数的时候，界面报「可清理 1 个」而点了删掉的却是别的数。
  assert.equal(result.deletedFiles, before.deletableFiles, `读数说可清理 ${before.deletableFiles} 个，实际删了 ${result.deletedFiles} 个`);
  assert.equal(result.freedBytes, 3000);
});

test('读数与清理同一套判据：报「可清理 N」就真的删掉那 N 个', async () => {
  const root = makeInbox();
  for (let i = 0; i < 4; i += 1) writeFile(root, '2026-10-19', `old-${i}.zip`, 100, (30 + i) * HOUR);
  for (let i = 0; i < 3; i += 1) writeFile(root, '2026-10-21', `new-${i}.zip`, 100, 3 * HOUR);
  const before = await scanInbox();
  const result = await clearInbox();
  assert.equal(result.deletedFiles, before.deletableFiles);
  assert.equal(result.freedBytes, before.deletableBytes);
  assert.equal(result.deletedFiles, 4);
});

test('自动清理默认关：关着的时候启动那次一条都不许删', async () => {
  const root = makeInbox();
  // 换一个**从来没写过开关**的 DSH_HOME：默认值只有在「文件不存在」时才看得出来，
  // 而 makeInbox 为了其它用例已经写过一次 false。
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-fresh-'));
  assert.equal(autoClearEnabled(), false, '没写过开关时必须按关处理（文件不存在 = 关）');
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  setAutoClear(false);
  writeFile(root, '2026-10-19', 'old.zip', 100, 40 * HOUR);
  const result = await clearInboxOnce();
  assert.equal(result, null, '开关关着就不该跑清理');
  assert.ok(fs.existsSync(path.join(root, '2026-10-19', 'old.zip')), '关着的时候文件必须原样留着');
});

test('开关读坏了当关，不当开', async () => {
  const root = makeInbox();
  const file = path.join(process.env.DSH_HOME, 'storages', 'mobile-plugin', 'inbox-auto-clear.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 坏掉的 json');
  assert.equal(autoClearEnabled(), false);
  writeFile(root, '2026-10-19', 'old.zip', 100, 40 * HOUR);
  assert.equal(await clearInboxOnce(), null, '读坏了必须是关 —— 自动删盘的缺省在安全的那一侧');
  assert.ok(fs.existsSync(path.join(root, '2026-10-19', 'old.zip')));
});

test('开关打开后启动那次才清，且每进程只清一次', async () => {
  const root = makeInbox();
  assert.equal(setAutoClear(true), true);
  writeFile(root, '2026-10-19', 'old.zip', 100, 40 * HOUR);
  const first = await clearInboxOnce();
  assert.equal(first.deletedFiles, 1);
  writeFile(root, '2026-10-19', 'old2.zip', 100, 40 * HOUR);
  const second = await clearInboxOnce();
  assert.equal(second, null, '同一进程里第二次装载不该再扫一遍盘');
  assert.ok(fs.existsSync(path.join(root, '2026-10-19', 'old2.zip')));
});

test('两条路由真的注册在移动端路由表里', () => {
  const table = readRouteTable();
  assert.match(table, /route\('\/api\/mobile\/v1\/inbox\/status'/, '缺 /inbox/status：App 与面板都会 404');
  assert.match(table, /route\('\/api\/mobile\/v1\/inbox\/clear'/, '缺 /inbox/clear');
});
