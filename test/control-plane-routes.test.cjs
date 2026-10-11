'use strict';

/**
 * 控制面路由（`/api/relay/*`）的守卫约定。
 *
 * 与移动端那套刻意不同：控制面**只认本机来源**（localOnly），移动端**只认 token**
 * （guarded）。这条不对称是安全的底线，不是风格问题——控制面能改配置、吊销全部授权、
 * 读带堆栈的进程级故障账本；把它暴露给中转等于把桌面端后门开到公网。
 *
 * 唯一的例外是 `/api/relay/internal/approval`：它由中转与局域网代理代转，没有本机
 * socket 可言，身份靠中转与 worker 之间的 sidecarToken。任何新加的例外都必须在这里
 * 一条条写明原因，否则半年后没人分得清哪条是必要的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROL_PLANE = path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js');

/** 允许不挂 localOnly 的控制面路由：key → 为什么。 */
const NO_LOCAL_ONLY = new Map([
  ['/api/relay/internal/approval', '由中转与局域网代理代转，没有本机 socket 可言；身份靠 sidecarToken（中转 ↔ worker 共享密钥），不是「这条路由不重要」的例外'],
]);

/**
 * 每条注册：`path` 后面、下一个 `path:` 之前的那段。
 *
 * 不去匹配整条 registerRoute(...) 的收尾括号——handler 里全是嵌套对象，平衡括号用
 * 正则匹配不出来（试过，11 条只解析出 2 条）。这里只关心「这条路径的 handler 段里有没有
 * 某个守卫」，按路径切段足够，也不依赖它被排版成几行。
 */
function registrations(source) {
  const hits = [...source.matchAll(/path:\s*'([^']+)'/g)];
  return hits.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    return { path: m[1], handler: source.slice(start, end) };
  });
}

test('控制面路由清单完整（解析条数下限防正则失效）', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const routes = registrations(source);
  assert.ok(routes.length >= 11, `只解析出 ${routes.length} 条控制面路由，正则可能失效了`);
  const known = new Set(routes.map((r) => r.path));
  for (const expected of [
    '/api/relay/internal/approval',
    '/api/relay/status',
    // 面板页（设置界面搬进宿主吐的 HTML）与它的「引导走完了」标记。
    // 面板页三个地址：自己分流 / 强制引导 / 强制主页。
    '/api/relay/panel',
    '/api/relay/panel/setup',
    '/api/relay/panel/settings',
    '/api/relay/onboarded',
    '/api/relay/desktop-view',
    '/api/relay/read-receipt',
    '/api/relay/desktop-read',
    '/api/relay/faults',
    '/api/relay/pairing',
    '/api/relay/toggle',
    '/api/relay/regenerate',
    '/api/relay/revoke-all',
    '/api/relay/config',
    '/api/relay/reconnect',
    '/api/relay/restart-sidecar',
    // 自更新那四条（2026-10 搬回外壳之后重新有）：状态 / 查更新 / 装并就地换代 / 自动开关。
    '/api/relay/update/status',
    '/api/relay/update/check',
    '/api/relay/update/apply',
    '/api/relay/update/auto',
  ]) {
    assert.ok(known.has(expected), `控制面少了 ${expected}`);
  }
});

test('除了写明原因的那条，其余控制面路由都挂在 localOnly 后面', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const bare = registrations(source)
    .filter((r) => r.path.startsWith('/api/relay/'))
    .filter((r) => !r.handler.includes('localOnly('))
    .map((r) => r.path);
  assert.deepEqual(bare.filter((p) => !NO_LOCAL_ONLY.has(p)), [], '控制面路由必须过 localOnly：本机来源是它唯一的防线');
});

test('豁免清单没腐化：每一条都还在，且写清了为什么', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const known = new Set(registrations(source).map((r) => r.path));
  for (const [route, why] of NO_LOCAL_ONLY) {
    assert.ok(known.has(route), `NO_LOCAL_ONLY 里的 ${route} 已经不存在了，请删掉这条豁免`);
    assert.ok(why.length > 20, `${route} 的豁免理由要写清楚，不能只是「特殊」`);
  }
  assert.equal(NO_LOCAL_ONLY.size, 1);
});

test('配对审批路由真的校验 sidecarToken，不是靠别的东西放行', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/internal/approval'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 800 : end);
  assert.match(route, /req\.headers\.authorization !== `Bearer \$\{sidecarToken\}`/, '配对审批必须校验中转↔worker 的共享密钥');
  assert.match(route, /sendJson\(res, 401, \{ error: 'unauthorized' \}\)/, '校验不过要回 401');
  // 决策要走 pairing-policy 的两种模式，不能在路由里另写一套准入判定。
  assert.match(route, /pairingApproval\.evaluate\(state\.pairingPolicy, body\.device\)/);
});

test('改配置的路由逐字段校验，不接受任意键', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/config'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1600 : end);
  for (const field of ['relayUrl', 'lanEnabled', 'lanPort', 'name', 'pairingPolicy', 'registerSecret']) {
    assert.ok(route.includes(`patch.${field}`), `config 路由必须逐字段校验并只写白名单字段，缺 ${field}`);
  }
  // 端口范围与注册密钥长度是防呆，别被"顺手清理"掉。
  assert.match(route, /body\.lanPort >= 1024 && body\.lanPort <= 65535/, '端口范围校验');
  assert.match(route, /body\.registerSecret\.length <= 512/, '注册密钥长度校验');
  assert.ok(!/\.\.\.body\b/.test(route), '不许把请求体整体透传进 settings.update');
});

test('面板读不到时报的是能定位的诊断，不是一句「还没构建」', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  // 三个面板地址共用 servePanel。2026-10-10 的真机现场：装完没重启，旧实例挂在被删掉的
  // 目录上，而那句写死的「还没构建」把人往「去跑 React 构建」上带 —— 所以诊断必须现场算。
  const at = source.indexOf('const servePanel');
  assert.notEqual(at, -1, '找不到 servePanel');
  const body = source.slice(at, at + 1200);
  assert.match(body, /panelDiagnosis\(\)/, 'servePanel 必须现场算诊断：三种现场（没重启 / 老版本 / 没构建）分不开，现场就会白折腾');
  assert.match(body, /code: 'panel_missing'/, 'panel_missing 这个 code 要留着');
  assert.ok(!source.includes('面板页面还没构建'), '写死的那句构建提示已被按现场分的诊断取代，别退回去');
});
