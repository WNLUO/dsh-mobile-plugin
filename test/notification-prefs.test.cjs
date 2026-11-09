'use strict';

/**
 * 通知按事件类型分级（`lib/mobile/notification-prefs.js`）的纯函数 + GET/PUT 信封测试。
 *
 * 真跑读写：每个用例把 `DSH_HOME` 指到临时目录，走一遍落盘再读回，不靠读源码字符串。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prefs = require('../lib/mobile/notification-prefs.js');

/** 每个用例一套独立 DSH_HOME，互不污染。 */
async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notif-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个假请求：`body` 直接被 readJsonBody 取用，`deviceId` 进可信记录。 */
function fakeReq({ method = 'GET', deviceId = 'dev-a', body } = {}) {
  return { method, __dshRecord: { deviceId }, body };
}

/** 造一个假响应：收集状态码与解析后的 JSON。 */
function fakeRes() {
  const res = {
    status: 0,
    json: undefined,
    req: { headers: {} },
    writeHead(status) { this.status = status; },
    end(chunk) { this.json = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); },
  };
  return res;
}

test('默认表：done 静默，其余响铃；键齐全', () => {
  assert.deepEqual(prefs.defaultEvents(), {
    done: 'silent',
    failed: 'ring',
    approval: 'ring',
    question: 'ring',
    planReview: 'ring',
  });
});

test('读缺失文件：逐键回默认，不 404', async () => {
  await withTempHome(() => {
    const got = prefs.readEvents('dev-a');
    assert.equal(got.version, 1);
    assert.deepEqual(got.events, prefs.defaultEvents());
    // 默认表是新对象，不共享引用
    got.events.done = 'off';
    assert.equal(prefs.defaultEvents().done, 'silent');
  });
});

test('读写往返：写入的值能读回', async () => {
  await withTempHome(() => {
    const written = prefs.writeEvents('dev-a', {
      done: 'ring',
      failed: 'off',
      approval: 'silent',
      question: 'ring',
      planReview: 'off',
    });
    assert.equal(written.ok, true);
    const got = prefs.readEvents('dev-a');
    assert.deepEqual(got.events, {
      done: 'ring',
      failed: 'off',
      approval: 'silent',
      question: 'ring',
      planReview: 'off',
    });
    assert.ok(got.updatedAt > 0);
  });
});

test('坏文件：读坏当默认', async () => {
  await withTempHome((dir) => {
    const file = path.join(dir, 'storages', 'mobile-plugin', 'notification-prefs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');
    assert.deepEqual(prefs.readEvents('dev-a').events, prefs.defaultEvents());
  });
});

test('缺键：缺哪键补哪键，有的照用', async () => {
  await withTempHome((dir) => {
    const file = path.join(dir, 'storages', 'mobile-plugin', 'notification-prefs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      updatedAt: 123,
      devices: { 'dev-a': { updatedAt: 123, events: { done: 'off', failed: 'silent' } } },
    }));
    const got = prefs.readEvents('dev-a');
    assert.deepEqual(got.events, {
      done: 'off',
      failed: 'silent',
      approval: 'ring',
      question: 'ring',
      planReview: 'ring',
    });
  });
});

test('未知键丢弃、非法值回默认（clamp）', async () => {
  await withTempHome(() => {
    const got = prefs.normalizeEvents({
      done: 'ring',
      failed: 'loud',      // 非法级别 → 回默认 ring
      approval: 42,        // 非字符串 → 回默认 ring
      question: 'off',
      bogus: 'ring',       // 未知事件键 → 丢
    });
    assert.deepEqual(got, {
      done: 'ring',
      failed: 'ring',
      approval: 'ring',
      question: 'off',
      planReview: 'ring',
    });
    assert.ok(!('bogus' in got));
    assert.equal(prefs.clampLevel('silent'), 'silent');
    assert.equal(prefs.clampLevel('nope'), null);
  });
});

test('按 deviceId 分桶：互不覆盖', async () => {
  await withTempHome(() => {
    prefs.writeEvents('dev-a', { done: 'off' });
    prefs.writeEvents('dev-b', { done: 'ring', failed: 'silent' });
    assert.equal(prefs.readEvents('dev-a').events.done, 'off');
    assert.equal(prefs.readEvents('dev-b').events.done, 'ring');
    assert.equal(prefs.readEvents('dev-b').events.failed, 'silent');
    // 再写 dev-a 不影响 dev-b
    prefs.writeEvents('dev-a', { question: 'off' });
    assert.equal(prefs.readEvents('dev-b').events.done, 'ring');
  });
});

test('GET 信封：{ ok, version, updatedAt, events }', async () => {
  await withTempHome(async () => {
    const res = fakeRes();
    await prefs.handleNotificationPrefs({}, fakeReq({ method: 'GET', deviceId: 'dev-a' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.version, 1);
    assert.ok('updatedAt' in res.json);
    assert.deepEqual(res.json.events, prefs.defaultEvents());
  });
});

test('PUT 信封：整表替换，回 { ok, updatedAt, events }，clamp 生效', async () => {
  await withTempHome(async () => {
    const res = fakeRes();
    await prefs.handleNotificationPrefs({}, fakeReq({
      method: 'PUT',
      deviceId: 'dev-a',
      body: { events: { done: 'ring', failed: 'bogus', extra: 'off' } },
    }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.updatedAt > 0);
    assert.equal(res.json.events.done, 'ring');
    assert.equal(res.json.events.failed, 'ring'); // 非法 → 默认
    assert.ok(!('extra' in res.json.events));
    // 真落了盘，GET 读得回同一份
    const got = fakeRes();
    await prefs.handleNotificationPrefs({}, fakeReq({ method: 'GET', deviceId: 'dev-a' }), got);
    assert.equal(got.json.events.done, 'ring');
  });
});

test('PUT 缺 events 对象：回 400', async () => {
  await withTempHome(async () => {
    const res = fakeRes();
    await prefs.handleNotificationPrefs({}, fakeReq({ method: 'PUT', body: {} }), res);
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  });
});
