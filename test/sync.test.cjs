'use strict';

/**
 * 设备批量同步（docs/device-batch-sync.md）电脑侧的行为。
 *
 * 钉四件事：
 *  1. 领券 → 用 `ticketId` 走正常配对能拿到凭据；同一张券第二次用必须失败（一次性）。
 *  2. 收件箱按 cid 去重、按 `since` 读、TTL 过期读不到；读坏盘时 write 绝不覆盖。
 *  3. 一次写超过 16 条整条请求被拒；inbox 那条按 method 分派，其它方法 405。
 *  4. 路由表里真的注册了三条端点、配对 handler 拿到同一份券表。
 *
 * 运行：node --test test/sync.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createTransferTickets } = require('../lib/mobile/transfer-tickets.js');
const { createSyncInboxStore } = require('../lib/mobile/sync-inbox-store.js');
const { createSyncHandlers } = require('../lib/mobile/sync.js');
const { createPairHandler, resetPairLocks } = require('../lib/mobile/pairing.js');
const e2ee = require('../lib/shared/e2ee.js');
const core = require('../lib/relay/core.js');
const pairingApproval = require('../lib/relay/pairing-policy.js');
const { readRouteTable } = require('./lib/wiring.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-'));
let fileSeq = 0;
const tmpFile = (name) => path.join(TMP, `${fileSeq += 1}-${name}`);

const INSTANCE = 'syncinst1';
const STATE = {
  instanceId: INSTANCE,
  name: '客厅电脑',
  enabled: true,
  relayUrl: 'wss://relay.example/x',
  lanEnabled: true,
  lanPort: 18787,
  pairingPolicy: 'code',
};

/** 最小 res 假体：记下状态码与 JSON 体。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    headers: {},
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    end(raw) {
      if (raw && this.status === 0) this.status = 200;
      try { this.body = JSON.parse(raw); } catch { this.body = raw; }
    },
  };
}

/** 带请求体 / method / url 的 req 假体。 */
function fakeReq(payload, { method = 'POST', url = '/', ip = '10.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: ip };
  req.setEncoding = () => {};
  process.nextTick(() => {
    if (payload !== undefined) req.emit('data', JSON.stringify(payload));
    req.emit('end');
  });
  return req;
}

/** 组一份协议 v2 的加密配对请求（模拟手机侧：拿券派生 pairKey 再封）。 */
function sealPairRequest({ ticket, instanceId, device }) {
  const deviceKey = crypto.randomBytes(32).toString('base64url'); // 43 字符
  const keyId = crypto.randomBytes(8).toString('hex'); // 16 位十六进制
  const pairKey = e2ee.derivePairKey(Buffer.from(ticket, 'base64url'), instanceId);
  const plain = JSON.stringify({ device, deviceKey, keyId });
  const sealed = e2ee.seal(pairKey, Buffer.from(plain, 'utf8'), e2ee.pairAad(instanceId));
  return Buffer.from(sealed).toString('base64');
}

function makeSync({ state = STATE, ticketStore, inboxStore }) {
  return createSyncHandlers({
    state,
    ticketStore,
    inboxStore,
    safeLanCandidates: (port) => [{ url: `http://192.168.1.5:${port}` }],
    safeIpv6Candidates: () => [{ url: 'http://[240e::1]:18787' }],
    lanPortInUse: () => 18787,
    hostPlatform: () => 'darwin',
    log: () => {},
  });
}

function makePair(transferTickets) {
  const issued = [];
  const credentials = {
    issue(instanceId, device) {
      issued.push({ instanceId, device });
      return { deviceId: device.deviceId || 'dev-1', credential: 'dshc_test', expiresAt: 1 };
    },
  };
  const handler = createPairHandler({
    state: { ...STATE },
    core,
    credentials,
    pairingApproval,
    lanCandidates: () => [],
    ipv6Candidates: () => [],
    lanPort: () => 18787,
    transferTickets,
    log: () => {},
  });
  return { handler, issued };
}

test('领券 → 用 ticketId 配对成功，券被用掉', async () => {
  resetPairLocks();
  const ticketStore = createTransferTickets();
  const syncH = makeSync({ ticketStore, inboxStore: createSyncInboxStore({ file: tmpFile('inbox.json') }) });

  const mintRes = fakeRes();
  await syncH.handleMintTickets(null, fakeReq({ count: 1 }), mintRes);
  assert.equal(mintRes.status, 200);
  assert.equal(mintRes.body.ok, true);
  // 宿主概况要带给导出方手机：新手机靠它拼二维码、知道该拨哪里。
  assert.equal(mintRes.body.host.instanceId, INSTANCE);
  assert.equal(mintRes.body.host.name, '客厅电脑');
  assert.equal(mintRes.body.host.proto, 2);
  assert.equal(mintRes.body.host.relayUrl, 'wss://relay.example/x');
  assert.deepEqual(mintRes.body.host.lanUrls, ['http://192.168.1.5:18787']);
  assert.deepEqual(mintRes.body.host.ipv6Candidates, ['http://[240e::1]:18787']);
  assert.equal(mintRes.body.host.hostPlatform, 'darwin');
  assert.equal(mintRes.body.tickets.length, 1);

  const { ticket, ticketId } = mintRes.body.tickets[0];
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/, '券是 32 字节 base64url');
  assert.ok(ticketId, '要带 ticketId');

  const { handler, issued } = makePair(ticketStore);
  const sealed = sealPairRequest({ ticket, instanceId: INSTANCE, device: { deviceId: 'new-phone', name: '新手机', platform: 'ios' } });
  const pres = fakeRes();
  await handler(fakeReq({ instanceId: INSTANCE, sealed, ticketId }), pres);

  assert.equal(pres.status, 200, `应当 200，实际 ${pres.status} ${JSON.stringify(pres.body)}`);
  assert.equal(pres.body.ok, true);
  // 回包是协议 v2 密文：解出来应当有 token。
  const pairKey = e2ee.derivePairKey(Buffer.from(ticket, 'base64url'), INSTANCE);
  const opened = JSON.parse(e2ee.open(pairKey, Buffer.from(pres.body.sealed, 'base64'), e2ee.pairAad(INSTANCE)).toString('utf8'));
  assert.match(opened.token, /^\S+$/, '配对回包里要有可用的 token');
  assert.equal(issued.length, 1, '凭据库应当被调用一次');
  assert.equal(issued[0].device.deviceId, 'new-phone');
  // 配成功即作废。
  assert.equal(ticketStore.resolve(INSTANCE, ticketId), null, '配对成功后券必须失效');
});

test('同一张券第二次用必然失败（一次性）', async () => {
  resetPairLocks();
  const ticketStore = createTransferTickets();
  const [{ ticket, ticketId }] = ticketStore.mint(INSTANCE, 1);
  const { handler, issued } = makePair(ticketStore);

  const first = fakeRes();
  await handler(fakeReq({ instanceId: INSTANCE, sealed: sealPairRequest({ ticket, instanceId: INSTANCE, device: { deviceId: 'p1' } }), ticketId }), first);
  assert.equal(first.status, 200);

  const second = fakeRes();
  await handler(fakeReq({ instanceId: INSTANCE, sealed: sealPairRequest({ ticket, instanceId: INSTANCE, device: { deviceId: 'p2' } }), ticketId }), second);
  assert.equal(second.status, 401, '同一张券不能再配第二台手机');
  assert.equal(second.body.ok, false);
  assert.equal(issued.length, 1, '被拒的那次不签发凭据');
});

test('可复用券：配成功后不作废，多台组内手机各用一次（自动同步用）', async () => {
  resetPairLocks();
  const ticketStore = createTransferTickets();
  const [{ ticket, ticketId }] = ticketStore.mint(INSTANCE, 1, { ttlMs: 24 * 60 * 60 * 1000, reusable: true });
  const { handler, issued } = makePair(ticketStore);

  for (const id of ['phone-a', 'phone-b', 'phone-c']) {
    const res = fakeRes();
    await handler(fakeReq({ instanceId: INSTANCE, sealed: sealPairRequest({ ticket, instanceId: INSTANCE, device: { deviceId: id } }), ticketId }), res);
    assert.equal(res.status, 200, `${id} 应当能用同一张可复用券配上`);
  }
  assert.equal(issued.length, 3, '三台手机各得一份凭据');
  assert.equal(ticketStore.resolve(INSTANCE, ticketId), ticket, '可复用券配完仍在（到期才失效）');
});

test('收件箱：按 cid 去重、按 since 读、TTL 过期', () => {
  let clock = 1_000_000;
  const store = createSyncInboxStore({ file: tmpFile('ttl.json'), now: () => clock, ttlMs: 1000 });
  const id = 'inst-x';

  // 同一批里重复 cid 只存一条；accepted 仍回报它（幂等）。
  const accepted = store.write(id, [
    { cid: 'a', blob: 'AAAA' },
    { cid: 'b', blob: 'BBBB' },
    { cid: 'a', blob: 'AAAA' },
  ]);
  assert.deepEqual(accepted, ['a', 'b', 'a']);
  assert.equal(store.read(id, 0).length, 2, '同 cid 只存一份');

  // since 严格大于：与记录同一时刻的 since 读不到它，早一点能读到。
  assert.equal(store.read(id, 1_000_000).length, 0);
  const after = store.read(id, 999_999);
  assert.equal(after.length, 2);
  assert.equal(after[0].createdAt, 1_000_000);

  // 同 cid 再写不改旧内容、不新增。
  assert.deepEqual(store.write(id, [{ cid: 'a', blob: 'ZZZZ' }]), ['a']);
  assert.equal(store.read(id, 0).find((r) => r.cid === 'a').blob, 'AAAA');

  // 单条超 8KB 拒收。
  assert.deepEqual(store.write(id, [{ cid: 'big', blob: 'x'.repeat(8 * 1024 + 1) }]), []);

  // 超过 TTL 后读不到。
  clock += 1001;
  assert.equal(store.read(id, 0).length, 0, '超过 24h 的记录不再返回');
});

test('收件箱读到坏文件：read 当空表，write 绝不覆盖', () => {
  const file = tmpFile('corrupt.json');
  fs.writeFileSync(file, '{ not json');
  const store = createSyncInboxStore({ file });
  assert.deepEqual(store.read('i', 0), [], '读失败按空表');
  assert.throws(() => store.write('i', [{ cid: 'a', blob: 'A' }]), /损坏|corrupt/, '读坏盘时不能当成空库重写');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', '盘上原有内容必须原样保留');
});

test('收件箱 handler：POST 写 → GET 读；超 16 条整条 400；其它方法 405', async () => {
  const store = createSyncInboxStore({ file: tmpFile('handler.json') });
  const syncH = makeSync({ ticketStore: createTransferTickets(), inboxStore: store });

  const wres = fakeRes();
  await syncH.handleInbox(null, fakeReq({ records: [{ cid: 'c1', blob: 'AAA' }, { cid: 'c2', blob: 'BBB' }] }), wres);
  assert.equal(wres.status, 200);
  assert.deepEqual(wres.body.accepted, ['c1', 'c2']);

  const gres = fakeRes();
  await syncH.handleInbox(null, fakeReq(undefined, { method: 'GET', url: '/api/mobile/v1/sync/inbox?since=0' }), gres);
  assert.equal(gres.status, 200);
  assert.equal(gres.body.records.length, 2);
  assert.deepEqual(gres.body.records.map((r) => r.cid).sort(), ['c1', 'c2']);

  const tooMany = fakeRes();
  const many = Array.from({ length: 17 }, (_, i) => ({ cid: `x${i}`, blob: 'A' }));
  await syncH.handleInbox(null, fakeReq({ records: many }), tooMany);
  assert.equal(tooMany.status, 400, '单次超过 16 条应当整条拒绝');

  const bad = fakeRes();
  await syncH.handleInbox(null, fakeReq(undefined, { method: 'PUT' }), bad);
  assert.equal(bad.status, 405);
});

test('路由表注册了同步端点，且配对 handler 拿到同一份券表', () => {
  const table = readRouteTable();
  assert.match(table, /route\('\/api\/mobile\/v1\/sync\/tickets'/, '缺少 /sync/tickets');
  assert.match(table, /route\('\/api\/mobile\/v1\/sync\/inbox'/, '缺少 /sync/inbox');
  assert.match(table, /transferTickets/, 'createPairHandler 必须拿到券表');
});
