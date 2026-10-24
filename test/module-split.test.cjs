'use strict';

/**
 * 守卫：lib/mobile/sessions.js 的模块边界。
 *
 * 起因：sessions.js 一度长到 1964 行，HTTP 路由、宿主 RPC 调用、缓存与纯事件派生
 * 全混在一个文件里。它是 lib/mobile 下被引用最多的模块（stream / credentials /
 * skills / subagents / workspaces / host-settings 都从它取 unwrap、callSessions 等），
 * 一旦继续膨胀，改一处缓存语义就可能波及所有 handler。
 *
 * 这里钉的是**边界本身**，不是某段实现：
 *   1. sessions.js 必须回到一个可读的行数区间；
 *   2. 纯派生逻辑必须住在 history-derive.js，且不得反向依赖 sessions.js（防环）；
 *   3. 会话模块之间不得出现循环 require；
 *   4. sessions.js 对外的导出面不能因为拆分而缩水（其它模块都从它取东西）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MOB = path.join(__dirname, '..', 'lib', 'mobile');
const SESSIONS = path.join(MOB, 'sessions.js');
const HISTORY = path.join(MOB, 'history-derive.js');
const ENVELOPE = path.join(MOB, 'envelope.js');

const read = (file) => fs.readFileSync(file, 'utf8');
const lineCount = (file) => read(file).split('\n').length;

test('sessions.js 从 1964 行降下来，且没有反弹回单体', () => {
  const lines = lineCount(SESSIONS);
  assert.ok(
    lines < 1600,
    `sessions.js 应保持在 1600 行以内，实际 ${lines} 行（拆分前是 1964）`,
  );
  assert.ok(lines > 300, `sessions.js 只剩 ${lines} 行，疑似把路由层也搬空了`);
});

test('纯派生逻辑住在 history-derive.js，不在 sessions.js 里', () => {
  const derive = read(HISTORY);
  const sessions = read(SESSIONS);
  // 这些函数是「事件 → 展示结构」的纯计算，不碰 ctx、不发 RPC。
  for (const name of ['deriveMessages', 'listTitle', 'errorDetails', 'promptErrorObject']) {
    assert.match(derive, new RegExp(`^function ${name}\\(`, 'm'), `${name} 应定义在 history-derive.js`);
    assert.doesNotMatch(
      sessions,
      new RegExp(`^function ${name}\\(`, 'm'),
      `${name} 仍定义在 sessions.js，纯派生逻辑没有搬干净`,
    );
  }
});

// unwrap 是信封拆解，不是纯派生：它曾经有 3 份逐字相同的实现（history-derive /
// workspaces / agent-presets），6 个模块为了拿这 5 行去 require 一个 1400 行的
// sessions.js —— 那正是 sessions.js 拆不动的根因。现在唯一实现在 envelope.js。
test('信封拆解只有一份实现在 envelope.js，且谁都不再自带一份', () => {
  const envelope = read(ENVELOPE);
  assert.match(envelope, /^function unwrap\(/m, 'unwrap 应定义在 envelope.js');
  assert.match(envelope, /^function envelopeValue\(/m, 'envelopeValue 应定义在 envelope.js');
  // envelope.js 必须是叶子：它一旦开始 require 别人，就会被上面的环检测反向依赖牵连。
  assert.doesNotMatch(envelope, /require\(/, 'envelope.js 不该依赖任何模块');

  const owners = ['history-derive.js', 'workspaces.js', 'agent-presets.js', 'sessions.js', 'stream.js'];
  for (const file of owners) {
    assert.doesNotMatch(
      read(path.join(MOB, file)),
      /^function unwrap\(/m,
      `${file} 又自己实现了一份 unwrap —— 信封拆解必须只有 envelope.js 一份`,
    );
  }
  // 仍从 history-derive 间接取 unwrap 的老调用方保留（导出面不能缩），
  // 但 sessions.js / stream.js 必须已经改指 envelope.js。
  for (const file of ['sessions.js', 'stream.js']) {
    assert.match(
      read(path.join(MOB, file)),
      /require\(['"]\.\/envelope\.js['"]\)/,
      `${file} 仍为了一行 unwrap 去 require 会话领域模块`,
    );
  }
});

test('history-derive.js 是叶子模块：不反向依赖 sessions.js', () => {
  const derive = read(HISTORY);
  assert.doesNotMatch(
    derive,
    /require\(['"]\.\/sessions\.js['"]\)/,
    'history-derive.js 反向 require 了 sessions.js，会形成循环依赖',
  );
  // 纯函数模块不该碰 HTTP 工具与宿主 RPC。
  assert.doesNotMatch(derive, /require\(['"]\.\.\/shared\/http-util['"]\)/, '纯派生模块不应依赖 http-util');
});

test('lib/ 里不存在循环 require', () => {
  // 图要覆盖整个 lib/ 递归子树，而且 ./ 与 ../ 都要认：
  //  - 只扫 lib/mobile 一层，require('./host-bridge/transport.js') 这种指子目录的边
  //    整条丢掉，于是「mobile/*.js → host-bridge → 回到 mobile/*.js」这种穿过子目录的
  //    环看不见；
  //  - 只认 './' 的话 lib/mobile/*.js → ../shared/*.js 的边也没了，而 auth.js 就是
  //    靠这条边连到凭据库的。
  // .cjs 与 .js 一样参与：lib/ 下的子目录声明了 type=commonjs，两者都走 require。
  const LIB = path.join(__dirname, '..', 'lib');
  const files = [];
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (/\.c?js$/.test(entry.name)) files.push(rel);
    }
  })(LIB, '');

  // require 的写法不统一：不带扩展名、带 .js、带目录。要按 node 的真实解析顺序试出来，
  // 不能一律拼 '.js'——拼错就会静默丢边，而丢边是检测器最坏的失败方式（它看起来一直
  // 在跑，实际什么都没看见）。基准目录是**发起 require 的那个文件所在目录**：
  // host-bridge/*.js 里的 './shims.js' 是同目录，不是 lib/ 根。
  const resolve = (fromFile, spec) => {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    for (const candidate of [joined, `${joined}.js`, `${joined}.cjs`, `${joined}/index.js`, `${joined}/index.cjs`]) {
      if (files.includes(candidate) && fs.statSync(path.join(LIB, candidate)).isFile()) return candidate;
    }
    return null;
  };

  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  const unresolved = [];
  for (const file of files) {
    // 必须先剥注释：文档里解释「谁从谁取」时会写出 require 字样，
    // 原先的检测器把说明文当成真依赖，一句注释就报出「自己依赖自己」。
    const source = read(path.join(LIB, file))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const deps = new Set();
    for (const m of source.matchAll(/require\(['"](\.\.?\/[\w.\-/]+)['"]\)/g)) {
      const target = resolve(file, m[1]);
      // 落在 lib/ 之外的（lib/mobile/auth.js 够到的 ../../dsh-mobile-credentials）不归
      // 这张图管——跨包那几条的形态由 plugin-ota.test.cjs 钉着。但落在 lib/ 之内却
      // 找不到文件的，一定是拼错了：放过它，上面的遍历就是在残图上跑的。
      if (target !== null) deps.add(target);
      else if (!m[1].startsWith('..')) unresolved.push(`${file} → ${m[1]}`);
    }
    edges.set(file, deps);
  }
  assert.deepEqual(unresolved, [], 'lib/ 里存在指向不存在文件的相对 require');
  // 对每个模块做一次可达性遍历，若能走回自己就是环。记下父节点，好把整条环打印出来：
  // 报「A 与 A 之间存在循环」等于没报，得让人一眼看出是哪几个文件绕回来的。
  for (const start of files) {
    const parent = new Map([[start, null]]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const dep of edges.get(cur) || []) {
        if (dep === start) {
          const chain = [];
          for (let node = cur; node !== null; node = parent.get(node)) chain.unshift(node);
          assert.fail(`存在循环 require：${[...chain, start].join(' → ')}`);
        }
        if (!parent.has(dep)) {
          parent.set(dep, cur);
          stack.push(dep);
        }
      }
    }
  }
});

test('任何 mobile 模块解构的东西，被依赖方都必须真的导出', () => {
  // 这里的原始意图是「sessions.js 的导出面不能因拆分而缩水」。写成只查 sessions.js
  // 之后，它随 unwrap / callSessions 的迁走自己先失效了（跨模块引用从 4 个掉到 3 个，
  // 触发了它自己的下限断言）。所以改成通用形态：扫全图，逐条 require 核对导出面，
  // 以后再拆出新模块也不用回来改这里。
  const files = fs.readdirSync(MOB).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));
  const strip = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

  /** @type {Map<string, Set<string>>} */
  const exported = new Map();
  for (const file of files) {
    const source = strip(read(path.join(MOB, file)));
    const tail = source.slice(source.lastIndexOf('module.exports'));
    const names = new Set();
    if (tail !== source) {
      const body = tail.replace(/^module\.exports\s*=\s*/, '').replace(/;\s*$/, '');
      if (body.trimStart().startsWith('{')) {
        for (const part of body.slice(1, body.lastIndexOf('}')).split(',')) {
          const alias = part.split(':');
          names.add((alias[1] ?? alias[0]).trim());
        }
      } else {
        for (const m of body.matchAll(/(\w+)\s*[,:}]/g)) names.add(m[1]);
      }
    }
    exported.set(file, names);
  }

  let checked = 0;
  for (const file of files) {
    const source = strip(read(path.join(MOB, file)));
    for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/([\w.-]+)['"]\)/g)) {
      const target = /\.c?js$/.test(m[2]) ? m[2] : `${m[2]}.js`;
      if (!exported.has(target)) continue;
      for (const raw of m[1].split(',')) {
        const name = raw.split(':')[0].trim();
        if (!name) continue;
        checked += 1;
        assert.ok(
          exported.get(target).has(name),
          `${file} 从 ${target} 解构了 ${name}，但 ${target} 没有导出它`,
        );
      }
    }
  }
  assert.ok(checked >= 8, `只核对到 ${checked} 条 require，正则可能失效了`);

  // sessions.js 的导出面清单本身仍然钉死：它是 mobile/ 下被引用最多的模块。
  const publicSurface = [
    'callSessions', 'buildSessionsResponse', 'SESSIONS_PREVIEW_LIMIT',
    'buildMessagesSnapshot', 'buildStatsSnapshot', 'buildSingleSessionMirror',
    'buildMirrorWarmSnapshots', 'buildModelsSnapshot', 'promptOnce',
    'promptErrorObject', 'MODEL_UNAVAILABLE_ERROR', 'sendIdempotencyStateOf',
    'completionStateOf', 'sessionModelsStateOf', 'invalidateSessionModels',
    'invalidateSessionList', 'listTitle', 'deriveMessages',
    'resolveEventAttachments', 'unwrap', 'handleSessions', 'handleSession',
    'handleMessages', 'handleSend', 'handleCommands', 'handleSessionRead',
    'handleSessionAttachment',
    'handleStop', 'handleRename', 'handleFork', 'handleModels',
    'handleSelectModel', 'handleStats', 'handleSessionSearch',
    'handleAgentPresets', 'handleNew',
    'handleGoalAction', 'handleQueueUpdate',
  ];
  const sessions = exported.get('sessions.js');
  for (const name of publicSurface) {
    assert.ok(sessions.has(name), `sessions.js 的 module.exports 少了 ${name}`);
  }
});

test('宿主 RPC 的三扇门只有一份实现，且带上三条不能丢的语义', () => {
  const files = fs.readdirSync(MOB).filter((f) => f.endsWith('.js'));
  const owners = ['callSessions', 'callAgentPresets', 'mobilePromptRpcId'];
  for (const name of owners) {
    const defined = files.filter((f) => new RegExp(`^function ${name}\\(`, 'm').test(read(path.join(MOB, f))));
    assert.deepEqual(defined, ['rpc.js'], `${name} 的实现应当只有 lib/mobile/rpc.js 一份，实际在 ${defined.join('、') || '没有'}`);
  }
  // 会话模块都必须从 rpc.js 取，不能各自再写一份。
  for (const consumer of ['sessions.js', 'agent-presets.js', 'stream.js']) {
    const src = read(path.join(MOB, consumer));
    assert.match(src, /require\('\.\/rpc\.js'\)/, `${consumer} 应当从 rpc.js 取 RPC 转发`);
  }
  const rpc = read(path.join(MOB, 'rpc.js'));
  // 语义 1：signal 必须显式传给宿主的 sessions.<method>(request, signal)——宿主内部
  // 直接读 signal.aborted 且不做 undefined 兜底，漏传会让 search 这类方法抛
  // "Cannot read properties of undefined (reading 'aborted')"。
  assert.match(rpc, /ctx\.apiProxy\.sessions\[method\]\(\{ rpcId, method: `session\.\$\{method\}`, payload \}, signal\)/);
  // 语义 2+3：list 的在途合流表按 ctx 隔离，且 ?fresh=1 的写后刷新不能搭在途请求的车。
  assert.match(rpc, /const sessionListInFlight = new WeakMap\(\)/);
  assert.match(rpc, /if \(options && options\.fresh\) return invoke\(\);/);
  assert.match(rpc, /const existing = sessionListInFlight\.get\(ctx\);/);
});

test('按 ctx 隔离的可变状态只在 session-cache.js 与 rpc.js 里', () => {
  const files = fs.readdirSync(MOB).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));
  // WeakMap 是「模块级可变状态」的唯一标记。这些表的值属于宿主进程状态（会话在跑、
  // 列表刚构建完、发送已幂等过），必须按 ctx 隔离；它们此前散在 sessions.js 的模块
  // 顶层，和 handler 混在一起，看不出哪行是状态、哪行是逻辑。集中之后加一张新表只能
  // 加在 session-cache.js / rpc.js，别的地方再冒出 WeakMap 就是没走这条路。
  const owners = new Map();
  for (const file of files) {
    const hits = (read(path.join(MOB, file)).match(/new WeakMap\(\)/g) || []).length;
    if (hits) owners.set(file, hits);
  }
  assert.deepEqual([...owners.keys()].sort(), ['rpc.js', 'session-cache.js'], `模块级 WeakMap 跑到了 ${[...owners.keys()].join('、')}`);
  // 归档清理新增 deletedSessionIds，避免宿主旧列表快照复活已删除会话。
  // 其它表覆盖模型目录 / 列表响应 / 预览 / 预览在途 / 预览时钟 / 镜像历史 / 完成态 /
  // 完成代际 / 上一轮事实 / 发送幂等 / 写操作幂等 / 工作区列表短路。
  assert.equal(owners.get('session-cache.js'), 13, '会话侧的十三张表（含已删除会话 ID 与上一轮事实）：状态均按 ctx 隔离');
  // session-cache.js 是叶子：它不许反过来依赖任何会话模块。
  assert.doesNotMatch(read(path.join(MOB, 'session-cache.js')), /require\(/);
  // 对外路径不变：这五个访问器仍从 sessions.js 转出。
  const sessions = read(path.join(MOB, 'sessions.js'));
  assert.match(sessions, /require\('\.\/session-cache\.js'\)/);
  for (const name of ['invalidateSessionList', 'invalidateSessionModels', 'completionStateOf', 'sessionModelsStateOf', 'sendIdempotencyStateOf']) {
    assert.match(sessions, new RegExp(`^  ${name},$`, 'm'), `sessions.js 的导出面应当继续转出 ${name}`);
  }
});

// host-bridge.js 曾经是 751 行、只有 12%（约 90 行）是传输适配，其余四层混在一起：
// 网关传输、端点表、合成器、装配。端点表尤其危险——它错一次不报错，只是让某个 UI
// 整层静默消失（见 host-bridge-endpoints.test.cjs 的开头）。
// 拆分后钉的是依赖方向：transport 是叶子，endpoints 单向下行依赖 shims，装配在最外层。
test('host-bridge 的四层依赖方向是单向的，装配留在最外层', () => {
  const DIR = path.join(MOB, 'host-bridge');
  const files = fs.readdirSync(DIR);
  assert.deepEqual(
    files.filter((f) => f.endsWith('.js')).sort(),
    ['endpoints.js', 'event-synthesis.js', 'shims.js', 'transport.js'],
    'host-bridge 目录下的文件构成变了，请同步这份守卫与 endpoints.js 的依赖声明',
  );

  const requires = (file) => [...read(path.join(DIR, file)).matchAll(/require\('\.\/([\w.-]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires('transport.js'), [], 'transport.js 必须是叶子：它不该依赖同目录任何文件');
  assert.deepEqual(requires('shims.js').sort(), ['transport.js'], 'shims.js 只许依赖 transport.js');
  assert.deepEqual(requires('event-synthesis.js').sort(), ['transport.js'], 'event-synthesis.js 只许依赖 transport.js');
  assert.deepEqual(
    requires('endpoints.js').sort(),
    ['shims.js', 'transport.js'],
    'endpoints.js 只许依赖 transport.js 与 shims.js（不许反过来让 shims 依赖它，会成环）',
  );

  // 装配层：host-bridge.js 本身只负责把端点表铺成 apiProxy.<ns>.<method>。
  const bridge = read(path.join(MOB, 'host-bridge.js'));
  assert.ok(lineCount(path.join(MOB, 'host-bridge.js')) < 120, 'host-bridge.js 不该再长回去，它只剩装配');
  const fromSubdir = [...bridge.matchAll(/require\('\.\/host-bridge\/([\w-]+)\.js'\)/g)].map((m) => m[1]);
  assert.deepEqual(
    fromSubdir.sort(),
    ['endpoints', 'event-synthesis', 'transport'],
    '装配层应当且只应当从 host-bridge/ 子目录取实现',
  );
  assert.doesNotMatch(
    bridge,
    /gateway\.invoke|\{ namespace, method, args \}/,
    '网关调用只许出现在 host-bridge/transport.js，装配层不许自己 invoke',
  );
});

// 网关调用必须**全部**经过 transport.js。0.2.1 起每个请求都要自带 Peer 身份
// （assertPeerLive），绕开传输层直连 `ctx.get('typertGateway')` 就是对 undefined
// 读 `.signal`：命令目录因此静默变空（「+」菜单只剩添加媒体 / 添加文件），@ 补全与
// 插件清单则整块报错。这条把「还有谁在直连」钉成一次全目录扫描，新增模块照抄旧写法
// 会当场红，而不是等真机上某个 UI 一片空白才发现。
test('网关直连只许出现在 host-bridge/transport.js', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs)$/.test(entry.name)) continue;
      const rel = path.relative(MOB, full).split(path.sep).join('/');
      if (rel === 'host-bridge/transport.js') continue;
      const src = read(full);
      // 去掉注释再判：说明「为什么不能直连」的注释本身不该触发这条守卫。
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/gateway\.invoke\s*\(|get\(['"]typertGateway['"]\)/.test(code)) offenders.push(rel);
    }
  };
  walk(MOB);
  assert.deepEqual(offenders, [], `这些模块绕开了 host-bridge/transport.js：${offenders.join('、')}`);
});

// sessions.js 1964 → 393 行后，剩下的只是会话列表 + 新建 + 排队动作。按域拆出去的九个子
// 模块必须各守自己的行数区间：只要有人把某个域又搬回 sessions.js，这条就红。
// 钉「谁住在哪」比钉行数更耐改，所以这里两样都查，但行数区间给得宽，防的是膨胀不是搬回。
test('sessions.js 只剩会话列表，九个子模块各守一个领域', () => {
  const sessions = read(SESSIONS);
  const lines = lineCount(SESSIONS);
  assert.ok(lines < 500, `sessions.js 应保持在 500 行以内，实际 ${lines}（拆分前是 1964）`);

  const HOME = {
    'attachments.js': ['resolveEventAttachments'],
    'completion.js': ['observeCompletionEvent', 'updateCompletionStates', 'confirmCompletionFromHistory'],
    'session-last-turn.js': ['settleOutcome', 'recordLastTurn', 'lastTurnOf'],
    'session-models.js': ['buildModelsSnapshot', 'handleModels', 'handleSelectModel', 'safeModelsValue'],
    'session-search.js': ['sanitizeSearchQuery', 'handleSessionSearch'],
    'session-send.js': ['promptOnce', 'handleSend', 'handleCommands', 'handleFork', 'handleSessionAttachment'],
    'session-snapshot.js': ['eventSeqOf', 'buildMessagesSnapshot', 'statsProjections', 'handleMessages'],
    'session-mirror.js': ['buildSingleSessionMirror', 'buildMirrorWarmSnapshots'],
    'session-goal.js': ['callGoals', 'handleGoalAction'],
    'session-presets.js': ['handleAgentPresets'],
  };
  const CEILING = {
    'attachments.js': 160, 'completion.js': 150, 'session-last-turn.js': 130, 'session-models.js': 220,
    'session-search.js': 120, 'session-send.js': 330, 'session-snapshot.js': 200,
    'session-mirror.js': 200, 'session-goal.js': 90, 'session-presets.js': 100,
  };
  for (const [file, names] of Object.entries(HOME)) {
    const text = read(path.join(MOB, file));
    assert.ok(
      lineCount(path.join(MOB, file)) <= CEILING[file],
      `${file} 涨到 ${lineCount(path.join(MOB, file))} 行，超过 ${CEILING[file]} 的上限`,
    );
    for (const name of names) {
      assert.match(text, new RegExp(`^((async )?function ${name}\\(|  ${name},$)`, 'm'), `${name} 应该住在 ${file}`);
      assert.doesNotMatch(
        sessions,
        new RegExp(`^(async )?function ${name}\\(`, 'm'),
        `${name} 又被搬回 sessions.js 了`,
      );
    }
  }

  // 导出面看着别缩水：sessions.js 仍是 lib/mobile 下被引用最多的模块（stream / credentials /
  // skills / subagents / workspaces / host-settings 全从它取东西）。下面这份是拆分前的
  // 37 个名字加 2026-10 的单图重取 handler（handleSessionAttachment）= 38，一个不多一个不少——
  // 多一个说明有人把内部细节漏出来了，少一个说明有人顺手删了别的模块还要的东西。
  const FACADE = [
    'callSessions', 'buildSessionsResponse', 'SESSIONS_PREVIEW_LIMIT', 'buildMessagesSnapshot',
    'buildStatsSnapshot', 'buildSingleSessionMirror', 'buildMirrorWarmSnapshots', 'buildModelsSnapshot',
    'promptOnce', 'promptErrorObject', 'MODEL_UNAVAILABLE_ERROR', 'sendIdempotencyStateOf',
    'completionStateOf', 'sessionModelsStateOf', 'invalidateSessionModels', 'invalidateSessionList',
    'listTitle', 'deriveMessages', 'resolveEventAttachments', 'unwrap', 'handleSessions',
    'handleSession', 'handleMessages', 'handleSend', 'handleCommands', 'handleSessionRead',
    'handleSessionAttachment',
    'handleStop', 'handleRename', 'handleFork', 'handleModels', 'handleSelectModel', 'handleStats',
    'handleSessionSearch', 'handleAgentPresets', 'handleNew', 'handleGoalAction', 'handleQueueUpdate',
    // 正文水位探针（App 进对话前问「正文到哪了」）：只读 sessionSignal 快照，不发 RPC。
    'handleSessionHead',
  ];
  const table = sessions.slice(sessions.indexOf('module.exports = {'));
  const exported = [...table.matchAll(/^  ([A-Za-z_]\w*),$/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), [...FACADE].sort(), 'sessions.js 的导出面变了（拆分前 37 个，加单图重取与正文水位探针后 39 个）');
  // 实现必须来自子模块：导出表里出现一个本文件没 require 过的名字，就有人手抄了一份。
  const prelude = sessions.slice(0, sessions.indexOf('module.exports = {'));
  for (const name of exported) {
    if (FACADE.includes(name) === false) continue;
    const fromChild = new RegExp(`\\b${name}\\b[^;]*require\\('\\./[\\w-]+\\.js'\\)`);
    const declaredHere = new RegExp(`^(async )?function ${name}\\(|^const ${name} =`, 'm');
    assert.ok(
      fromChild.test(prelude) || declaredHere.test(prelude),
      `${name} 既没在本文件定义，也没从子模块 require —— 导出表和实现对不上`,
    );
  }
});
