'use strict';

/**
 * 宿主半边自检口（`/api/relay/host-half` 与它的 reload）的守卫。
 *
 * 这两条由**外壳**注册，不是实现：实现装载失败时整张 `/api/relay/*` 都不在，而那一半
 * 为什么没起来只有外壳答得出来。当场的样子是设置页一句「插件宿主侧没有加载」，原因只打在
 * 宿主 stderr 里，桌面端不落盘 —— 用户看不见，我们也查不出来。这条口就是为了让原因出来。
 *
 * 所以这里钉三件事：①响应体只挑该给的格子、脏值不抛（纯函数测）；②这两条确实挂在外壳上
 * 并走控制面守卫；③客户端那两个常量与宿主路径逐字对齐（两边漂开就是「点了没反应」）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHELL = path.join(__dirname, '..', 'lib', 'index.js');
const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');
const RUNTIME = path.join(__dirname, '..', 'lib', 'shell', 'runtime.js');
// `lib/shell/` 没有自己的 package.json，跟随包根的 `type: module` —— 只能 import。
const HALF_VIEW = path.join(__dirname, '..', 'lib', 'shell', 'half-view.js');
const HALF_ROUTE = path.join(__dirname, '..', 'lib', 'shell', 'half-route.js');

test('响应体只挑该给的格子：脏值一律收成 null / false / 0', async () => {
  const { hostHalfView } = await import(HALF_VIEW);
  const view = hostHalfView({
    version: '0.5.0',
    source: 'npm',
    activatedAt: '2026-10-29T00:00:00.000Z',
    lastError: '装载 0.5.0 超时：它可能卡在等一个永远不来的依赖服务上',
    retrying: true,
    retryAttempts: 3,
    nextRetryAt: '2026-10-29T00:02:00.000Z',
  }, { installedVersion: '0.5.0', shellChanged: true });
  assert.deepEqual(view, {
    ok: true,
    half: {
      version: '0.5.0',
      source: 'npm',
      previousVersion: null,
      activatedAt: '2026-10-29T00:00:00.000Z',
      lastError: '装载 0.5.0 超时：它可能卡在等一个永远不来的依赖服务上',
      retrying: true,
      retryAttempts: 3,
      nextRetryAt: '2026-10-29T00:02:00.000Z',
      installedVersion: '0.5.0',
      shellChanged: true,
    },
  });

  // 装载失败的现场：一代都没有，版本是 null，但原因必须原样留着。
  const blank = hostHalfView({ lastError: '所有可用插件实现均装载失败：装载 0.5.0 失败：xxx' });
  assert.equal(blank.half.version, null);
  assert.equal(blank.half.lastError, '所有可用插件实现均装载失败：装载 0.5.0 失败：xxx');
  assert.equal(blank.half.retrying, false);
  assert.equal(blank.half.retryAttempts, 0);

  // 脏输入不许抛：这条路由是「宿主已经半死」时才被用到的。
  const junk = hostHalfView(null, null);
  assert.equal(junk.ok, true);
  assert.equal(junk.half.version, null);
  assert.equal(junk.half.shellChanged, false);
  assert.equal(hostHalfView({ lastError: 42 }).half.lastError, null);
  assert.equal(hostHalfView({ retryAttempts: 'three' }).half.retryAttempts, 0);
});

test('两条路由挂在外壳的 webServer 上，并走控制面守卫', () => {
  const route = fs.readFileSync(HALF_ROUTE, 'utf8');
  // 挂在实现里等于「实现又挂了就没有出口」，这是这两条存在的全部理由。
  assert.match(route, /const server = ctx\?\.webServer/);
  assert.match(route, /export const HOST_HALF_PATH = '\/api\/relay\/host-half'/);
  assert.match(route, /export const HOST_HALF_RELOAD_PATH = '\/api\/relay\/host-half\/reload'/);
  assert.match(route, /localOnly\('GET', async \(_req, res\) => sendJson\(res, 200, view\(\)\)\)/);
  assert.match(route, /localOnly\('POST'/);
  // 重新装载走的是外壳那套换代秩序（串行、先停后起），不是自己 import 一遍。
  assert.match(route, /runtime\.reload\(\)/);
  // 外壳只留一行接线：业务代码（哪怕只是路由拼装）住进 shell/，外壳的行数守卫才守得住。
  const shell = fs.readFileSync(SHELL, 'utf8');
  assert.match(shell, /installHostHalf\(ctx, runtime, \{ installedVersion, installedShellHash, runningShellHash \}\)/);
});

test('客户端的两个常量与宿主路径逐字对齐，且仍是文档相对地址', () => {
  const client = fs.readFileSync(CLIENT, 'utf8');
  assert.match(client, /HOST_HALF_ENDPOINT = '\/api\/relay\/host-half'/);
  assert.match(client, /HOST_HALF_RELOAD_ENDPOINT = '\/api\/relay\/host-half\/reload'/);
  // 站点根绝对地址在反代子路径下会 404（2026-10-25 那条现场），别再写回去。
  assert.equal(/fetch\(\s*['"]\//.test(client), false);
});

test('装载失败之后还在后台接着试，不是躺平到下次重启', () => {
  const source = fs.readFileSync(RUNTIME, 'utf8');
  assert.match(source, /const RETRY_BACKLOG_MS = 120000/);
  assert.match(source, /function scheduleBacklogRetry\(log\)/);
  // 失败那一条出口必须排上后台补齐；成功与卸载两条出口必须把它清掉。
  assert.match(source, /scheduleBacklogRetry\(log\)\n\s+throw new Error\(lastFailure\)/);
  assert.match(source, /clearBacklogRetry\(\)\n\s+return status\(\)/);
  assert.match(source, /async function detach\(\) \{\n\s+detached = true\n\s+clearBacklogRetry\(\)/);
  // 装载上限放宽到 60s：20s 在慢机器上不够（失败首因是注入的服务晚就位）。
  const ms = Number((source.match(/const ACTIVATE_TIMEOUT_MS = (\d+)/) || [])[1]);
  assert.ok(ms >= 60000, `装载上限仍是 ${ms}ms`);
});
