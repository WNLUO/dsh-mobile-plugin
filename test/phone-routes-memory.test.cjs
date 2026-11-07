'use strict';

/**
 * 成功路线记忆 + phone_route_hint 的守卫。
 *
 * 用临时 DSH_HOME 驱动真实现（paths 在调用时解析 env），所以这里能真的落盘、读回、覆盖。
 * 重点钉四件事：每包 20 条上限、只在成功时记（失败/空步骤不记）、坏文件安静退化、只给摘要
 * 且不自动执行（查询工具的返回里没有设备字段、没有 undefined）。
 *
 * 运行：node --test test/phone-routes-memory.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-routes-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const routesMemory = require('../lib/mobile/phone/routes-memory.js');
const routeHint = require('../lib/mobile/phone/route-hint.js');
const routes = require('../lib/mobile/phone/routes.js');

const PKG = 'com.tencent.mm';

function step(action, args) {
  return { action, args: args || {} };
}

/** 直接写一份账本，绕过 record 的 Date.now（用来钉排序真值）。 */
function writeStoreRaw(store) {
  fs.mkdirSync(path.dirname(routesMemory.routesFile()), { recursive: true });
  fs.writeFileSync(routesMemory.routesFile(), JSON.stringify(store));
}

test('record 落盘到固定位置，list 能原样读回', () => {
  routesMemory.resetForTest();
  const steps = [step('app.open', { packageName: PKG }), step('tap', { target: '聊天' }), step('type', { text: '在吗' })];
  const bucket = routesMemory.record(PKG, steps);
  assert.equal(bucket.length, 1);
  assert.ok(fs.existsSync(routesMemory.routesFile()), '应写到 phone-routes.json');
  assert.ok(routesMemory.routesFile().includes(path.join('storages', 'mobile-plugin', 'phone-routes.json')));

  const listed = routesMemory.list(PKG);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].steps.map((s) => s.action), ['app.open', 'tap', 'type']);
  assert.equal(listed[0].steps[2].args.text, '在吗');
  assert.equal(typeof listed[0].at, 'number');
  assert.equal(listed[0].hits, 0);
});

test('只在成功时记：空包名、空步骤、非数组都不记', () => {
  routesMemory.resetForTest();
  assert.deepEqual(routesMemory.record('', [step('tap', { target: 'x' })]), []);
  assert.deepEqual(routesMemory.record(PKG, []), []);
  assert.deepEqual(routesMemory.record(PKG, null), []);
  assert.deepEqual(routesMemory.list(PKG), []);
  assert.equal(fs.existsSync(routesMemory.routesFile()), false, '什么都没记时不该建文件');
});

test('按包名分桶，互不串', () => {
  routesMemory.resetForTest();
  routesMemory.record(PKG, [step('tap', { target: '微信A' })]);
  routesMemory.record('com.sina.weibo', [step('tap', { target: '微博B' })]);
  assert.equal(routesMemory.list(PKG).length, 1);
  assert.equal(routesMemory.list('com.sina.weibo').length, 1);
  assert.ok(routesMemory.list(PKG)[0].steps[0].args.target.includes('微信'));
  assert.ok(routesMemory.list('com.sina.weibo')[0].steps[0].args.target.includes('微博'));
});

test('每个包最多 20 条，超了挤掉最旧的', () => {
  routesMemory.resetForTest();
  for (let i = 0; i < 25; i += 1) {
    routesMemory.record(PKG, [step('tap', { target: `第${i}步` })]);
  }
  const listed = routesMemory.list(PKG);
  assert.equal(listed.length, routesMemory.MAX_PER_PACKAGE);
  assert.equal(listed.length, 20);
  assert.equal(listed[0].steps[0].args.target, '第5步', '最旧的 0-4 应被挤掉');
  assert.equal(listed[19].steps[0].args.target, '第24步', '最新的应留在尾部');
});

test('文件读坏 / 形状不对时安静退化成空，不抛', () => {
  routesMemory.resetForTest();
  fs.mkdirSync(path.dirname(routesMemory.routesFile()), { recursive: true });
  fs.writeFileSync(routesMemory.routesFile(), '{ 这不是合法 JSON');
  assert.deepEqual(routesMemory.list(PKG), []);
  // 坏文件之后再记一条应能覆盖成合法账本
  routesMemory.record(PKG, [step('tap', { target: '重来' })]);
  assert.equal(routesMemory.list(PKG).length, 1);

  // 顶层是数组也不认
  writeStoreRaw([]);
  assert.deepEqual(routesMemory.list(PKG), []);

  // 包名不存在 -> 空
  assert.deepEqual(routesMemory.list('com.nonexistent.app'), []);
  assert.deepEqual(routesMemory.list(''), []);
});

test('summarizeStep / summarizeRoute 只给一句摘要', () => {
  assert.equal(routeHint.summarizeStep(step('app.open', { packageName: PKG })), '打开com.tencent.mm');
  assert.equal(routeHint.summarizeStep(step('tap', { target: '搜索框' })), '点击「搜索框」');
  assert.equal(routeHint.summarizeStep(step('type', { text: '天气' })), '输入「天气」');
  assert.equal(routeHint.summarizeStep(step('key', { key: 'back' })), '按键back');
  const summary = routeHint.summarizeRoute({
    at: 100,
    steps: [step('app.open', { packageName: PKG }), step('tap', { target: '搜索框' }), step('type', { text: '天气' })],
  });
  assert.equal(summary.stepCount, 3);
  assert.equal(summary.summary, '打开com.tencent.mm → 点击「搜索框」 → 输入「天气」');
});

test('hintFor 最多 5 条，最近的排前面', () => {
  routesMemory.resetForTest();
  writeStoreRaw({
    [PKG]: [
      { steps: [step('tap', { target: '旧1' })], at: 100, hits: 0 },
      { steps: [step('tap', { target: '旧2' })], at: 200, hits: 0 },
      { steps: [step('tap', { target: '新1' })], at: 600, hits: 0 },
      { steps: [step('tap', { target: '新2' })], at: 500, hits: 0 },
      { steps: [step('tap', { target: '新3' })], at: 400, hits: 0 },
      { steps: [step('tap', { target: '新4' })], at: 300, hits: 0 },
    ],
  });
  const hints = routeHint.hintFor(PKG);
  assert.equal(hints.length, 5, '最多 5 条');
  assert.equal(hints[0].summary, '点击「新1」', '最新的排第一');
  assert.equal(hints[4].summary, '点击「旧2」', '第 6 新的被截掉');
});

test('phone_route_hint 走 inject 注册，参数是 packageName，返回只有摘要不自动执行', async () => {
  routesMemory.resetForTest();
  routesMemory.record(PKG, [step('app.open', { packageName: PKG }), step('tap', { target: '搜索框' })]);

  const registered = [];
  const ctx = { inject(_names, cb) { cb({ tools: { register: (tool) => registered.push(tool) } }); } };
  routeHint.installRouteHint(ctx);

  const tool = registered.find((t) => t.name === 'phone_route_hint');
  assert.ok(tool, 'phone_route_hint 没注册上');
  const schema = tool.parameters || {};
  const props = schema.properties || {};
  assert.ok(props.packageName, '参数应有 packageName');
  assert.ok(Array.isArray(schema.required) && schema.required.includes('packageName'), 'packageName 应为必填');
  assert.ok(!props.deviceId, '参数里不该有 deviceId');

  const value = await tool.execute({ packageName: PKG }, {});
  assert.equal(value.ok, true);
  assert.equal(value.packageName, PKG);
  assert.equal(value.count, 1);
  assert.equal(value.routes.length, 1);
  assert.ok(value.routes[0].summary.includes('打开'));
  // 不发任何动作：结果里没有 deviceId / 执行痕迹
  assert.equal(value.deviceId, undefined);
  for (const v of Object.values(value)) assert.notEqual(v, undefined, '结果里不许有 undefined 字段');

  // 没记录的包：count 0，带一句 note，仍然没有 undefined
  const empty = await tool.execute({ packageName: 'com.nonexistent.app' }, {});
  assert.equal(empty.count, 0);
  assert.ok(empty.note && empty.note.length > 0);
  for (const v of Object.values(empty)) assert.notEqual(v, undefined);
});

test('缺 inject 的 profile 静默跳过，不抛', () => {
  assert.doesNotThrow(() => routeHint.installRouteHint({}));
  assert.doesNotThrow(() => routeHint.installRouteHint(null));
});

test('handlePhoneRoutes 只读地列路线摘要', async () => {
  routesMemory.resetForTest();
  routesMemory.record(PKG, [step('tap', { target: '搜索框' })]);

  const makeRes = () => {
    const res = {
      writeHead(status, headers) { res.status = status; res.headers = headers; },
      end(body) { res.body = String(body); },
    };
    return res;
  };

  assert.equal(typeof routes.handlePhoneRoutes, 'function');
  assert.equal(typeof routes.createPhoneRoutes({}).routes, 'function');

  const res = makeRes();
  await routes.handlePhoneRoutes({}, {}, { url: `/api/mobile/v1/phone/routes?package=${PKG}` }, res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.packageName, PKG);
  assert.equal(payload.count, 1);
  assert.ok(payload.routes[0].summary.includes('搜索框'));

  // 不带 package：空清单，不报错
  const emptyRes = makeRes();
  await routes.handlePhoneRoutes({}, {}, { url: '/api/mobile/v1/phone/routes' }, emptyRes);
  assert.equal(JSON.parse(emptyRes.body).count, 0);
});
