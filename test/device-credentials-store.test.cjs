'use strict';

/**
 * 每设备凭据库（讨论记录 §3.2 / §3.4 / §3.7 / §3.9）的契约。
 *
 * 这块是「单台吊销」与「协议 v2 验签」共同的地基，错了不会报错、只会静默失效：
 *  - 凭据本身就是 Bearer，**整串哈希**查库，不认前缀、不信 token 里的 exp；
 *  - 查到记录就以记录为准（吊销/过期立即拒），查不到才回退旧 HMAC；
 *  - 设备密钥按 **keyId** 找，不能按 deviceId（手机自填、可撞）；
 *  - 只剩一个写方：只读副本不写盘、不续期，改动靠文件变了重载；
 *  - 记录会清理（吊销/过期超 30 天整条删），不留一年扫表。
 *
 * 用真的临时文件跑，不 stub 落盘 —— 这些行为一半在「盘上那份」里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭据库在 require 时就把落盘路径定下来，所以环境变量必须先设。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-store-'));
const FILE = path.join(DIR, 'relay-device-credentials.json');
process.env.DEVICE_CREDENTIALS_FILE = FILE;

const credentials = require('../dsh-mobile-credentials/lib/credentials.js');

const INSTANCE = 'a1b2c3d4';
const KEY_ID = '0011223344556677';
const DEVICE_KEY = Buffer.alloc(32, 0x22).toString('base64url');

function reset() {
  credentials.resetForTest();
  try { fs.rmSync(FILE, { force: true }); } catch { /* 没有就算了 */ }
}

function raw() {
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('签发：凭据是 `<实例号>.<到期秒>.<随机>` 三段，三样返回同一枚', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1', name: 'iPhone' }, '')
  const parts = issued.credential.split('.')
  assert.equal(parts.length, 3, '必须保留三段：老 App 缺实例号时从第一段补')
  assert.equal(parts[0], INSTANCE)
  assert.equal(Number(parts[1]), Math.floor(issued.expiresAt / 1000), '第二段是到期秒，与记录一致')
  assert.match(parts[2], /^[A-Za-z0-9_-]{43}$/, '第三段是 32 字节 base64url，无补位')
  assert.equal(issued.expiresAt > Date.now(), true);
})

test('落盘：只存整串的 sha256；deviceKey 按原文存（验签要拿它重算）', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1' }, '', undefined, { deviceKey: DEVICE_KEY, keyId: KEY_ID })
  const [record] = raw()
  assert.equal(record.hash, crypto.createHash('sha256').update(issued.credential).digest('hex'))
  assert.ok(!JSON.stringify(raw()).includes(issued.credential), '盘上不能出现凭据原文')
  assert.equal(record.deviceKey, DEVICE_KEY, 'deviceKey 必须是原文：注释写着「只有哈希」在这它身上不成立')
  assert.equal(record.keyId, KEY_ID)
  assert.equal(record.format, 't1')
  assert.equal(record.hostToken, '', '新记录不再存 hostToken')
})

test('查库：整串哈希对得上才算，前缀/形状不参与判断', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1' }, '')
  assert.ok(credentials.lookup(issued.credential, INSTANCE), '整串可查到')
  assert.equal(credentials.lookup(`${issued.credential}x`, INSTANCE), null, '改一个字节就查不到')
  assert.equal(credentials.lookup(issued.credential, 'ffffffff'), null, '实例号不符不算本机的')
  assert.ok(credentials.lookup(issued.credential), '不传实例号也能查（旁路只知道自己在哪个实例时用）')
})

test('吊销：查到的记录以记录为准，revoked 立刻生效且不回退', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1' }, '')
  assert.equal(credentials.find(issued.credential, INSTANCE) !== null, true)
  assert.equal(credentials.revoke(issued.credential, INSTANCE), true)
  assert.equal(credentials.find(issued.credential, INSTANCE), null, '吊销后 find 必须为空')
  assert.ok(credentials.lookup(issued.credential, INSTANCE).revokedAt, '记录还在（打了标记），但已经不 live')
  assert.equal(credentials.revoke(issued.credential, INSTANCE), false, '重复吊销不重复计数')
})

test('单台吊销：按 deviceId 吊销它名下所有仍有效的记录', () => {
  reset();
  const a = credentials.issue(INSTANCE, { deviceId: 'phone-1' }, '')
  const b = credentials.issue(INSTANCE, { deviceId: 'phone-1' }, '')
  const c = credentials.issue(INSTANCE, { deviceId: 'phone-2' }, '')
  assert.equal(credentials.revokeDevice(INSTANCE, 'phone-1'), 2, '同一台重配两次就吊销两条')
  assert.equal(credentials.find(a.credential, INSTANCE), null)
  assert.equal(credentials.find(b.credential, INSTANCE), null)
  assert.ok(credentials.find(c.credential, INSTANCE), '别的设备不受影响')
})

test('按 keyId 找设备密钥：吊销后不认，也不能被更老的记录复活', () => {
  reset();
  credentials.issue(INSTANCE, { deviceId: 'd1' }, '', undefined, { deviceKey: DEVICE_KEY, keyId: KEY_ID })
  assert.ok(credentials.findByKeyId(INSTANCE, KEY_ID), '活的记录能查到')
  assert.equal(credentials.findByKeyId(INSTANCE, 'ffffffffffffffff'), null)
  assert.equal(credentials.findByKeyId('ffffffff', KEY_ID), null, '实例号不符不算')
  const [record] = raw()
  credentials.revokeDevice(INSTANCE, record.deviceId)
  assert.equal(credentials.findByKeyId(INSTANCE, KEY_ID), null, '吊销后不再给密钥')
})

test('指「最近连接」：内存即时更新，落盘按分钟节流', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1' }, '')
  const record = credentials.lookup(issued.credential, INSTANCE)
  // issue 刚写完盘，节流窗内 touch 不落盘，但内存里已经改了。
  assert.equal(credentials.touch(record, { channel: 'lan' }), true)
  assert.ok(record.lastSeenAt > 0)
  assert.equal(record.lastChannel, 'lan')
  assert.equal(raw()[0].lastChannel, undefined, '节流窗内不写盘')
})

test('滑动续期：过掉一半才后推，未过半不动；只读副本不续期', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1' }, '', 1000)
  const record = credentials.lookup(issued.credential, INSTANCE)
  record.expiresAt = Date.now() + 400 // 剩 400 / 1000 = 40% < 一半 → 该续
  const before = record.expiresAt
  assert.equal(credentials.renew(record, 1000), true, '剩不到一半要续')
  assert.ok(record.expiresAt > before)
  // 刚续完，剩余量超过一半 → 再调用不动
  const afterRenew = record.expiresAt
  assert.equal(credentials.renew(record, 1000), false, '没过一半不重复续')
  assert.equal(record.expiresAt, afterRenew)
})

test('清理：吊销/过期超过 30 天才整条删，刚吊销的还留着（面板要看）', () => {
  reset();
  const issued = credentials.issue(INSTANCE, { deviceId: 'd1' }, '')
  credentials.revoke(issued.credential, INSTANCE)
  assert.equal(raw().length, 1, '刚吊销不能立刻删：设备列表要能显示「已解绑」的状态与时间')
  // 直接把吊销时间拨回 31 天前，再写一次盘触发清理。
  const records = raw()
  records[0].revokedAt = Date.now() - 31 * 24 * 3600 * 1000
  fs.writeFileSync(FILE, JSON.stringify(records))
  credentials.refresh()
  credentials.issue(INSTANCE, { deviceId: 'd2' }, '')
  assert.equal(raw().length, 1, '过期的老记录该被清掉，只剩刚签的那条')
  assert.equal(raw()[0].deviceId, 'd2')
})

test('只读副本：不许签发（要走 IPC），文件变了能读到主进程新签的那条', () => {
  reset();
  // 切成只读副本，模拟旁路子进程：它先读过一次盘，此刻盘上什么都没有。
  credentials.setReadOnly(true)
  assert.equal(credentials.isReadOnly(), true)
  assert.throws(
    () => credentials.issue(INSTANCE, { deviceId: 'local' }, ''),
    (error) => error.code === 'READ_ONLY',
    '只读副本自己签发会写出「配上了但立刻查不到」的半截状态，必须直接抛',
  )
  assert.equal(fs.existsSync(FILE), false, '只读副本不得写盘')

  // 主进程（**另一个进程**）签了一条并落盘。
  //
  // 这里必须直接写文件、不能走 `credentials.issue`：同进程调 issue 会把记录写进本进程的
  // 内存数组，那样「只读副本会不会重读盘」根本测不出来（变异证明跑过，用 issue 时把
  // refresh 换成 load 仍然全绿）。落盘格式照 `issue` 的产物写：整串用 sha256。
  credentials.setReadOnly(false)
  const owner = credentials.issue(INSTANCE, { deviceId: 'from-host' }, '')
  const credential = owner.credential
  const externalRecord = {
    instanceId: INSTANCE,
    deviceId: 'from-host',
    hash: crypto.createHash('sha256').update(credential).digest('hex'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    format: 't1',
  }
  credentials.resetForTest()
  credentials.setReadOnly(true)
  // 读一次盘（此刻只有上面那条被删掉的旧记录），再把「主进程刚签的那条」追加进去。
  credentials.lookup('not-issued-yet', INSTANCE)
  const records = raw()
  records.push(externalRecord)
  fs.writeFileSync(FILE, JSON.stringify(records, null, 2))
  // 旁路**不需要任何显式重读**就能看到它：查一次就按文件指纹跟住变化。
  //
  // 这条是 2026-10-24 的现场回归：以前 `lookup` 只 `load()`（一生读一次盘），于是子进程
  // 起来之后才配对的设备在局域网口永远 401 —— 普通请求与 Metro 的预览通道都过不去，
  // App 只能退回公网中转；重启一次子进程又「自己好了」，最难查的那种。
  assert.ok(credentials.lookup(credential, INSTANCE), '只读副本必须自己跟住主进程新签的那条')
  assert.equal(credentials.refresh(), false, '刚跟过一次，指纹没变就一个系统调用都不多做')
  assert.throws(
    () => credentials.revoke(owner.credential, INSTANCE),
    (error) => error.code === 'READ_ONLY',
    '只读副本吊销了不落盘、下次重载就复活，必须直接抛而不是假装成功',
  )
})

test('设备清单：按 deviceId 聚合，取最新有值的名字、最早绑定、最大最近连接', () => {
  reset();
  credentials.setReadOnly(false)
  // 老记录：没有名字、没有密钥材料 → legacy。
  const old = credentials.issue(INSTANCE, { deviceId: 'p1' }, '')
  const records = raw()
  records[0].format = undefined // 模拟老式：没有 format 字段
  records[0].createdAt = Date.now() - 10_000
  delete records[0].format
  fs.writeFileSync(FILE, JSON.stringify(records))
  credentials.refresh()
  // 新记录：带名字、机型与密钥材料。
  const fresh = credentials.issue(INSTANCE, { deviceId: 'p1', name: '小明的 iPhone', model: 'iPhone 15 Pro', platform: 'ios', osVersion: '18.1' }, '', undefined, { deviceKey: DEVICE_KEY, keyId: KEY_ID })
  const record = credentials.lookup(fresh.credential, INSTANCE)
  credentials.touch(record, { channel: 'relay' })
  credentials.prune()

  const rows = credentials.listDevices(INSTANCE)
  assert.equal(rows.length, 1, '同一台重配两次只出一行')
  assert.equal(rows[0].name, '小明的 iPhone', '名字取最新一条有值的（老记录是空的，不能覆盖它）')
  assert.equal(rows[0].model, 'iPhone 15 Pro', '机型同样取最新一条有值的')
  assert.equal(rows[0].platform, 'ios')
  assert.equal(rows[0].lastChannel, 'relay')
  assert.equal(rows[0].bindings, 2, '这台名下有两枚活凭据，界面要把「另有几条旧绑定」摆出来')
  assert.equal(rows[0].suffix, '', '只有一台设备，标题不会撞，不给序号')
  assert.equal(rows[0].legacy, true, '带旧式记录的红旗必须立起来：单台吊销杀不掉旧 Bearer')
  assert.equal(rows[0].encrypted, true, '有设备密钥才走加密')
  assert.ok(!('hash' in rows[0]) && !('hostToken' in rows[0]) && !('deviceKey' in rows[0]), '面板拿不到凭据材料')
  assert.ok(old.credential)
})

test('撞名才给序号：标题取机型、机型空着才取名字；标题不同的不动', () => {
  reset();
  credentials.setReadOnly(false)
  const mk = (deviceId, extra) => credentials.issue(INSTANCE, { deviceId, platform: 'ios', ...extra }, '')
  mk('aaaa1111', { name: 'iPhone' })
  mk('bbbb2222', { name: 'iPhone' })
  mk('cccc3333', { name: 'iPad' })
  // 两台都没起名字、机型相同 → 标题都是「iPhone 15 Pro」，同样要编号。
  mk('dddd4444', { model: 'iPhone 15 Pro' })
  mk('eeee5555', { model: 'iPhone 15 Pro' })
  // 没起名字但机型不同 → 标题本来就分得开，不编号。
  mk('ffff6666', { model: 'Xiaomi 9' })
  // 机型相同、名字不同：标题取机型，所以照样撞，照样编号。
  mk('gggg7777', { model: 'Pixel 9', name: '桌上的' })
  mk('hhhh8888', { model: 'Pixel 9', name: '包里的' })
  const rows = credentials.listDevices(INSTANCE)
  const byId = Object.fromEntries(rows.map((row) => [row.deviceId, row]))
  assert.equal(byId.aaaa1111.name, 'iPhone', '名字原样返回，宿主不再往名字里拼机器号')
  assert.equal(byId.aaaa1111.suffix, '1', '早绑的是 1')
  assert.equal(byId.bbbb2222.suffix, '2')
  assert.equal(byId.cccc3333.suffix, '', '名字不同的不给序号')
  assert.equal(byId.dddd4444.suffix, '1', '没名字的两台按机型归到一组')
  assert.equal(byId.eeee5555.suffix, '2')
  assert.equal(byId.ffff6666.suffix, '', '机型不同就不是一组')
  assert.equal(byId.gggg7777.suffix, '1', '机型优先当标题：名字不同但同机型仍然算撞名')
  assert.equal(byId.hhhh8888.suffix, '2')
})

test('镜像摘要：只给活记录，吊销后立刻少一条', () => {
  reset();
  credentials.setReadOnly(false)
  const a = credentials.issue(INSTANCE, { deviceId: 'd1' }, '')
  credentials.issue(INSTANCE, { deviceId: 'd2' }, '')
  const before = credentials.activeDigests(INSTANCE)
  assert.equal(before.length, 2)
  assert.equal(before[before.length - 1].hash, crypto.createHash('sha256').update(a.credential).digest('hex'), '摘要与落盘同一口径')
  credentials.revoke(a.credential, INSTANCE)
  assert.equal(credentials.activeDigests(INSTANCE).length, 1, '吊销的立刻从推送清单里消失')
})
