'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { buildWorkspacesBody } = require('../lib/mobile/workspaces.js')
const { buildSessionsResponse } = require('../lib/mobile/sessions.js')
const { createWorkspaceGuard, createSessionListGuard, createEmptyListGuard } = require('../lib/shared/workspace-guard.js')
const { readWiring, readMirrorWiring } = require('./lib/wiring.cjs')

// 真机缺陷（用户报：侧边栏工作区整行消失、其下会话全塌进「未分组」）。
//
// 链路：DSH 0.2.0 没有一次性 workspace.list，只有 workspace.follow 流，取首帧 baseline
// 才是清单（host-bridge/shims.js 的 workspaceListViaFollow）。流「正常结束却没吐 baseline」时
// —— 宿主正在初始化 / 正忙 / 网关给了空流 —— 旧实现返回 ok({ items: [] })，与「你真的
// 没有工作区」在下游完全无法区分。buildWorkspacesBody 照单全收产出 { ok:true, items:[] }，
// 镜像守卫只检查 .ok 于是放行，中转把它冻结、只附一个 App 根本不看的 stale 标记，
// App 下一次 15s 轮询就把好数据覆盖成空，全程零报错。

// ── host-bridge 侧：拿不到 baseline 必须走错误通道 ────────────────────────────

test('workspace.follow 没给 baseline：host-bridge 如实报错，不谎报空清单', () => {
  // host-bridge 拆成目录后，workspaceListViaFollow 住在 shims.js。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'host-bridge', 'shims.js'), 'utf8');
  const start = src.indexOf('async function workspaceListViaFollow');
  assert.notEqual(start, -1, '缺少 workspaceListViaFollow');
  const body = src.slice(start, src.indexOf('\n}', start));
  // 注释里正好引用了旧的 ok({ items: [] }) 来解释历史，断言前先剥掉注释，
  // 否则会把说明文字当成残留代码。
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(
    !/ok\(\s*\{\s*items:\s*\[\]/.test(code),
    'workspaceListViaFollow 仍在把「没取到」表达成 ok({ items: [] })',
  );
  assert.ok(
    /code:\s*'host-workspace-baseline-missing'/.test(code),
    '缺少 host-workspace-baseline-missing 错误码，运维无法区分空与失败',
  );
  assert.ok(
    /catch \(error\)[\s\S]*?return fail\(error\)/.test(code),
    '流本身抛错的分支必须继续如实回报',
  );
  assert.ok(
    code.includes('return fail('),
    '没 baseline 的分支必须返回失败',
  );
});

test('workspace.follow 没给 baseline：buildWorkspacesBody 返回 ok:false 而不是空篮子', async () => {
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => ({
          result: {
            ok: false,
            error: { code: 'host-workspace-baseline-missing', message: '没有 baseline 帧' },
          },
        }),
      },
    },
  };
  const body = await buildWorkspacesBody(ctx);
  // 这是关键断言：ok 必须是 false。镜像守卫（lib/mirror/pusher.cjs 的 guardWorkspaces）只看 .ok，
  // 一旦这里给出 ok:true + 空 items，空清单就会被当权威数据广播出去。
  assert.equal(body.ok, false, '空篮子会通过镜像守卫，必须让 ok 为 false');
  assert.equal(body.error.code, 'host-workspace-baseline-missing');
  assert.equal(body.items, undefined, '失败时不得附带任何 items，避免下游误当空列表');
});

test('宿主回 ok 但不带 items：必须当成「没取到」而不是「你没有工作区」', async () => {
  const ctx = {
    apiProxy: {
      workspace: { list: async () => ({ result: { ok: true, value: {} } }) },
    },
  };
  const body = await buildWorkspacesBody(ctx);
  // 形状不对时谎报 ok:true + 空 items 是这条链路上最大的放大器：空篮子会通过
  // workspace-guard（只判 .ok）→ 被中转冻结 30s → App 下一次 15s 轮询覆盖好数据，
  // 侧边栏整树消失且零报错。早期版本把防线只放在守卫上，等于让每个读取点都先撒一次谎，
  // 现在读取侧必须自己如实报错。
  assert.equal(body.ok, false, '形状异常必须走错误通道');
  assert.equal(body.error.code, 'host-workspace-list-degraded');
  assert.equal(body.items, undefined, '失败时不得附带任何 items，避免下游误当空列表');
});

test('宿主回 ok 且 value 就是数组：按非空清单认下（不误伤）', async () => {
  const ctx = {
    apiProxy: {
      workspace: { list: async () => ({ result: { ok: true, value: [{ workspaceId: 'w1' }] } }) },
    },
  };
  const body = await buildWorkspacesBody(ctx);
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, [{ workspaceId: 'w1' }]);
});

test('宿主真的没有工作区：空数组照常认下（守卫负责的是「非空后的空」）', async () => {
  const ctx = {
    apiProxy: {
      workspace: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
    },
  };
  const body = await buildWorkspacesBody(ctx);
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, []);
});

// ── workspace-guard：空篮子不许覆盖非空清单 ────────────────────────────────────

test('守卫：非空清单放行，并记下时间基准', () => {
  const g = createWorkspaceGuard({ now: () => 1000 });
  assert.equal(g.check({ ok: true, items: [{ workspaceId: 'w1' }] }), null);
  assert.equal(g.peek().lastNonEmptyAt, 1000);
});

test('守卫：紧随非空清单的空快照被拒（真机症状的直接止血点）', () => {
  let t = 1000;
  const g = createWorkspaceGuard({ now: () => t });
  assert.equal(g.check({ ok: true, items: [{ workspaceId: 'w1' }] }), null);
  t = 1200;
  const blocked = g.check({ ok: true, items: [] });
  assert.ok(blocked, '空快照必须被拦下');
  assert.match(blocked, /未推送/, '阻断理由要能直接喂给 recordMirrorPush');
  assert.match(blocked, /没有工作区/, '理由要说清防的是什么，便于排障');
});

test('守卫：连续空快照一直不推进基准，宽限窗口内始终拦下', () => {
  let t = 1000;
  const g = createWorkspaceGuard({ now: () => t });
  g.check({ ok: true, items: [{ workspaceId: 'w1' }] });
  // 桌面侧每 500ms 推一次镜像，空篮子会被反复重试；窗口不能因为重试而被消耗掉。
  for (const step of [100, 300, 600, 900, 1400]) {
    t = 1000 + step;
    assert.ok(g.check({ ok: true, items: [] }), `+${step}ms 的空快照不该放行`);
  }
});

test('守卫：空过整个宽限窗口后放行，真实的「删光工作区」能收敛', () => {
  let t = 1000;
  const g = createWorkspaceGuard({ graceMs: 15000, now: () => t });
  g.check({ ok: true, items: [{ workspaceId: 'w1' }] });
  t = 1000 + 14000;
  assert.ok(g.check({ ok: true, items: [] }), '宽限窗口内应当拦下');
  t = 1000 + 16000;
  assert.equal(g.check({ ok: true, items: [] }), null, '超过宽限窗口应当放行');
  assert.equal(g.peek().lastNonEmptyAt, 0, '放行后要清基准，否则后续空快照一直被同一基准挡');
});

test('守卫：从来没有过非空清单时，空是事实，不拦', () => {
  const g = createWorkspaceGuard({ now: () => 5000 });
  assert.equal(g.check({ ok: true, items: [] }), null);
  assert.equal(g.check({ ok: true, items: [] }), null);
});

test('守卫：宿主报错一律拦下（与是否空无关）', () => {
  const g = createWorkspaceGuard();
  assert.ok(g.check({ ok: false, error: { code: 'boom' } }));
  assert.ok(g.check(null));
  assert.ok(g.check(undefined));
});

test('守卫：items 不是数组按空处理（与 buildWorkspacesBody 的兜底一致）', () => {
  let t = 1000;
  const g = createWorkspaceGuard({ now: () => t });
  g.check({ ok: true, items: [{ workspaceId: 'w1' }] });
  t = 1100;
  assert.ok(g.check({ ok: true, items: 'not-an-array' }));
  assert.ok(g.check({ ok: true }), '连 items 都没有也应按空处理');
});

test('守卫：非空清单重新出现会重置基准，恢复拦截能力', () => {
  let t = 1000;
  const g = createWorkspaceGuard({ now: () => t });
  g.check({ ok: true, items: [{ workspaceId: 'w1' }] });
  t = 20000;
  assert.equal(g.check({ ok: true, items: [] }), null, '宽限过后空放行');
  t = 20001;
  assert.equal(g.check({ ok: true, items: [{ workspaceId: 'w1' }] }), null);
  t = 20002;
  assert.ok(g.check({ ok: true, items: [] }), '新的非空清单应当重新成为基准');
});

// ── 接线：三处推送路径都必须过守卫 ─────────────────────────────────────────────

test('三条镜像推送路径都走 workspace-guard', () => {
  const src = readMirrorWiring();
  // 调度器搬到 lib/mirror/ 之后，相对路径从 './shared/...' 变成 '../shared/...'。
  assert.ok(src.includes("require('../shared/workspace-guard.js')"), '未接入 workspace-guard');
  assert.ok(/createWorkspaceGuard\(\s*\{/.test(src), '未创建守卫实例');
  const calls = src.match(/guardWorkspaces\(workspacesBody\)/g) || [];
  assert.equal(calls.length, 3, 'pushSessionNow / pushMirror / processBgQueue 三处都要过守卫');
  // 旧的宽松判定不能残留
  assert.ok(
    !/workspacesBody\?\.ok\s*\)?\s*(\{|;)/.test(src),
    '仍有直接用 workspacesBody?.ok 放行的路径',
  );
});

// ── 会话列表槽位：此前完全没有防线 ────────────────────────────────────────────
//
// 会话才是侧边栏的主体（工作区/项目下的对话）。只有工作区一侧有守卫时，宿主降级读
// 回一份空会话清单仍会被当权威广播出去：App 侧就是「设备还在、下面全没了」。

test('buildSessionsResponse：宿主 ok 但没有 items 数组时报错，不谎报空列表', async () => {
  const ctx = {
    apiProxy: {
      sessions: { list: async () => ({ result: { ok: true, value: { notItems: [] } } }) },
    },
  };
  const response = await buildSessionsResponse(ctx);
  // 500 而非 400：中转对 >=500 的小响应会退回上一份好副本（stale:true），
  // 手机上表现为「短暂用旧列表」而不是「列表被清空」。
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'host-session-list-degraded');
  assert.equal(response.body.items, undefined);
});

test('buildSessionsResponse：真的没有会话时空数组照常认下', async () => {
  const ctx = {
    apiProxy: {
      sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
    },
  };
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
});

test('会话守卫：非空之后的空被拦下，阻断理由能直接喂给 recordMirrorPush', () => {
  let t = 1000;
  const g = createSessionListGuard({ now: () => t });
  assert.equal(g.check({ ok: true, items: [{ sessionId: 's1' }] }), null);
  t = 1200;
  const blocked = g.check({ ok: true, items: [] });
  assert.ok(blocked, '会话空快照必须被拦下');
  assert.match(blocked, /未推送/);
  assert.match(blocked, /没有会话/);
});

test('三个推送路径的会话侧也过守卫', () => {
  const src = readMirrorWiring();
  assert.ok(/createSessionListGuard\(\s*\{/.test(src), '未创建会话守卫实例');
  const calls = src.match(/guardSessions\(sessionsBody\)/g) || [];
  assert.ok(calls.length >= 3, `pushSessionNow / pushMirror / processBgQueue 三处都要过会话守卫，实际 ${calls.length} 处`);
});

// ── 基准落盘：插件重启不该放行第一份空快照 ────────────────────────────────────

test('基准落盘后重启：进程内基准为空，仍拦得住空快照', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-baseline-'));
  const file = path.join(dir, 'mobile-empty-sessions.json');
  const first = createSessionListGuard({ persistPath: file, now: () => 5000 });
  assert.equal(first.check({ ok: true, items: [{ sessionId: 's1' }] }), null);
  // 模拟插件重启：新实例只拿到文件里的基准。
  const second = createSessionListGuard({ persistPath: file, now: () => 5200 });
  assert.equal(second.peek().lastNonEmptyAt, 5000, '基准应从磁盘恢复');
  assert.ok(second.check({ ok: true, items: [] }), '重启后的第一份空快照必须仍被拦下');
});

test('通用守卫：label 决定阻断理由，items 形状异常按空处理', () => {
  let t = 1000;
  const g = createEmptyListGuard({ label: '项目', now: () => t });
  g.check({ ok: true, items: [{ id: 1 }] });
  t = 1100;
  assert.match(g.check({ ok: true, items: 'not-an-array' }), /没有项目/);
  assert.match(g.check({ ok: true }), /没有项目/);
  assert.match(g.check(null), /项目 快照不可用/);
});