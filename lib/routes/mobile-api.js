'use strict';

/**
 * 移动端 API 路由表（`/api/mobile/v1/*`）。
 *
 * 这块此前是 lib/index.js 里连续 120 多行的注册语句，与控制面路由、sidecar 生命周期、
 * 镜像推送调度器混在同一个 apply() 闭包里。它本身没有任何逻辑——绝大部分是「路径 → 已
 * 写好的 handler」的纯映射，只有 status / connection-info / desktop-view 三条带一点内联
 * 逻辑——但混在装配代码里有两个代价：
 *
 *   1. 想确认「App 打的某个地址到底注册没有」必须人工通读 apply()。
 *      历史上 `workspace/rename` 与 `workspace/archive-session` 就是 App 一直在打、
 *      插件从来没注册，手机端必然 404。
 *   2. 改一条路径要在 1000 行文件里找。
 *
 * 现在它是一张可以一眼读完、可以对着 App 侧 apiPaths.ts 核对的表。
 *
 * 依赖注入只留三样：注册器、移动端守卫、以及两个会变的值。handler 们直接 require，
 * 因为它们本来就只是被这张表挂上去的。
 */

const { sendJson } = require('../http/routing.js');

const sessions = require('../mobile/sessions.js');
const agentPresets = require('../mobile/agent-presets.js');
const stream = require('../mobile/stream.js');
const events = require('../mobile/events.js');
const questions = require('../mobile/questions.js');
const workspaces = require('../mobile/workspaces.js');
const sessionLog = require('../mobile/session-log.js');
const hostSettings = require('../mobile/host-settings.js');
const skills = require('../mobile/skills.js');
const mobileCredentials = require('../mobile/credentials.js');
const subagents = require('../mobile/subagents.js');
const references = require('../mobile/references.js');
const plugins = require('../mobile/plugins.js');
const desktopView = require('../desktop-view.cjs');

const API_VERSION = '1';

/**
 * @param {object} deps
 * @param {(route: object) => void} deps.registerRoute 交给 ctx.webServer 的注册器
 * @param {(handler: Function) => Function} deps.guarded 移动端守卫（token + 500 信封）
 * @param {object} deps.state 内存里的中转状态（本进程唯一真值）
 * @param {() => object} deps.hostMetadata 宿主元信息（隧道准入状态等）
 * @param {() => object} deps.getSidecarSnapshot 取快照的**取值器**。
 *   这里必须传函数而不是对象：sidecarSnapshot 是会被 applySidecarConfig 整体替换的
 *   let 变量，闭包捕获对象会让 handler 永远读到启动那一刻的旧快照（lan.updatedAt 停在
 *   进程启动时间，手机端看连接信息像失联了一样）。
 * @param {(port: number) => Array<object>} deps.safeLanCandidates 局域网候选地址
 * @param {() => number} deps.lanPortInUse 手机该拨的局域网端口。**必须用取值器**：
 *   sidecar 自己 bind 到的端口可能与本进程解析出的不同（两条端口自适应），只认
 *   `state.lanPort` 会把这个接口变成「报一个没人监听的端口」——真机实测过 50933
 *   死地址把手机逼回公网中转（见 impl.js 的 advertisedLanPort）。
 * @param {(route: { path: string, handler: Function }) => void} deps.registerUpgradeRoute
 *   交给 ctx.webServer 的**升级**路由注册器（`registerUpgrade`）。与 registerRoute 是
 *   两套名字空间：同一个 path 可以既有一条普通路由又有一条升级路由，但升级路由重复注册
 *   会抛错。
 * @param {object} deps.preview 预览字节管道服务（lib/relay/preview.js）。它自带鉴权与
 *   端口边界，所以**不能**包在 guarded 里——guarded 回的是 JSON，而升级请求需要的是
 *   一次拒绝或一次握手。
 */
function registerMobileRoutes(deps) {
  const { registerRoute, registerUpgradeRoute, guarded, state, hostMetadata, getSidecarSnapshot, safeLanCandidates, lanPortInUse, preview } = deps;
  const route = (path, handler) => registerRoute({ kind: 'exact', path, handler: guarded(handler) })

  registerRoute({ kind: 'exact', path: '/api/mobile/v1/status', handler: guarded(async (_ctx, _req, res) => {
    // 内存 `state` 是本进程唯一的真值。旧实现这里 `loadRelayState()` 重新读盘，
    // 于是同一份状态出现两个来源：控制面改完内存立刻返回，而移动端读到的还是
    // 上一次落盘的内容（多实例/慢盘时甚至永久不一致）。
    sendJson(res, 200, {
      ok: true,
      apiVersion: API_VERSION,
      instanceId: state.instanceId || null,
      name: state.name || null,
      remoteEnabled: Boolean(state.enabled),
      ...hostMetadata(),
    })
  }) })
  // 局域网/中转连接信息。公网配对时由中转在 `/api/mobile/v1/connection-info`
  // 代答宿主上报的镜像数据；但纯局域网配对（App 只扫到局域网二维码、完全不经
  // 中转）需要宿主自己回答同一个地址，否则 App 拿不到 lanCandidates，换网卡后
  // 就再也找不到这台机器。字段与中转侧保持一致以便 App 用同一套解析。
  route('/api/mobile/v1/connection-info', async (_ctx, _req, res) => {
    // 端口取「手机该拨的那个」（sidecar 真 bind 成的），不是配置里的首选端口：
    // 两者不一致时这里报出去的候选是死地址，手机只能退回公网中转。
    const port = typeof lanPortInUse === 'function' ? lanPortInUse() : state.lanPort
    const candidates = state.lanEnabled ? safeLanCandidates(port) : []
    const lanUpdatedAt = getSidecarSnapshot()?.lan?.updatedAt || Date.now()
    sendJson(res, 200, {
      ok: true,
      instanceId: state.instanceId || null,
      name: state.name || null,
      relayUrl: state.enabled ? (state.relayUrl || null) : null,
      lanUrls: candidates,
      lanCandidates: candidates,
      updatedAt: lanUpdatedAt,
      lastSeen: lanUpdatedAt,
    })
  })

  route('/api/mobile/v1/sessions', sessions.handleSessions)
  route('/api/mobile/v1/session', sessions.handleSession)
  route('/api/mobile/v1/session/messages', sessions.handleMessages)
  route('/api/mobile/v1/session/send', sessions.handleSend)
  route('/api/mobile/v1/commands', sessions.handleCommands)
  route('/api/mobile/v1/session/read', sessions.handleSessionRead)
  route('/api/mobile/v1/session/stop', sessions.handleStop)
  route('/api/mobile/v1/session/rename', sessions.handleRename)
  route('/api/mobile/v1/session/fork', sessions.handleFork)
  route('/api/mobile/v1/session/models', sessions.handleModels)
  route('/api/mobile/v1/session/select-model', sessions.handleSelectModel)
  route('/api/mobile/v1/session/stats', sessions.handleStats)
  // 正文检索（宿主 session.search 的移动端代理）：只回 { sessionId, snippet }，
  // 标题 / 工作区由 App 用自己轮询到的会话列表拼接，见 mobile/sessions.js。
  route('/api/mobile/v1/session/search', sessions.handleSessionSearch)
  // Agent 预设（宿主 agentPreset.list / agentPreset.select 的移动端代理）。桌面端
  // 会话头标签、设置行、hero 芯片都读这份名单；宿主未配置 roster 时 list 回空数组。
  route('/api/mobile/v1/agent-presets', sessions.handleAgentPresets)
  // Agent 预设管理（宿主 agentPreset.read / copy / remove 的移动端代理）：桌面端设置页
  // 那个「管理分区」——只读查看器、复制（桌面端唯一的创建入口）、删除。此前手机只能
  // 看到名单与当前档，既读不到预设正文也造不出自己的预设。
  route('/api/mobile/v1/agent-presets/read', agentPresets.handleAgentPresetRead)
  route('/api/mobile/v1/agent-presets/copy', agentPresets.handleAgentPresetCopy)
  route('/api/mobile/v1/agent-presets/remove', agentPresets.handleAgentPresetRemove)
  route('/api/mobile/v1/session/new', sessions.handleNew)
  route('/api/mobile/v1/session/stream', stream.handleStream)
  route('/api/mobile/v1/events/stream', events.handleDeviceStream)
  route('/api/mobile/v1/question/respond', questions.handleQuestionRespond)
  route('/api/mobile/v1/approval/respond', questions.handleApprovalRespond)
  route('/api/mobile/v1/session/goal', sessions.handleGoalAction)
  route('/api/mobile/v1/session/queue/update', sessions.handleQueueUpdate)
  route('/api/mobile/v1/workspaces', workspaces.handleWorkspaces)
  // 桌面端工作区展开态镜像（由页面内的客户端半边经 /api/relay/desktop-view 回传）。
  // 桌面端只把这份状态记在浏览器 localStorage 里，宿主读不到，所以这里给 App 的只是
  // 「宿主最近收到的快照」；从未收到过时返回 view: null，App 按桌面的折叠缺省处理。
  route('/api/mobile/v1/desktop-view', async (_ctx, _req, res) => sendJson(res, 200, { ok: true, view: desktopView.snapshot() }))
  route('/api/mobile/v1/directory/list', workspaces.handleListDirectory)
  route('/api/mobile/v1/directory/create', workspaces.handleCreateDirectory)
  route('/api/mobile/v1/workspace/create', workspaces.handleCreateWorkspace)
  route('/api/mobile/v1/workspace/delete', workspaces.handleDeleteWorkspace)
  route('/api/mobile/v1/workspace/move-session', workspaces.handleMoveSession)
  // App 的 `renameWorkspace()` / `archiveSession()` 早就在打这两个地址
  // （`app/src/services/apiPaths.ts` 的 workspaceRename / workspaceArchiveSession），
  // 但插件从来没有注册 → 移动端「重命名工作区」和「归档会话」必然 404。
  route('/api/mobile/v1/workspace/rename', workspaces.handleRenameWorkspace)
  route('/api/mobile/v1/workspace/archive-session', workspaces.handleArchiveSession)
  // 桌面端 `/export` 其实是两步：命令本身只留一行 transcript 标记，真正的下载由
  // @deepseek-ai/dsh-session-log-export 在浏览器侧监听 command/executed 后拉
  // `GET /api/session.export` 完成。手机端没有浏览器下载管理器，而那个端点绑在宿主
  // 的 127.0.0.1 上手机直连不到 —— 所以由插件代取（mobile/session-log.js），App 侧
  // 再落盘。
  route('/api/mobile/v1/session-log', sessionLog.handleSessionLog)
  // 宿主设置与模型提供方（宿主 settings.describe / llm.providers 的移动端只读代理）。
  // 桌面端「设置」里有默认模型、提供方配置、凭据是否已设；手机端此前完全没有这一块，
  // 只能看到 App 自己的偏好项。两个宿主接口本身已脱敏（secrets 只给 path 与 set），
  // 插件再丢掉对手机没用的 schema 树，见 mobile/host-settings.js。
  route('/api/mobile/v1/host-settings', hostSettings.handleHostSettings)
  // 改设置：与桌面端同一个 settings.mutate（按路径寻址的 op + expectedRevision 乐观并发）。
  route('/api/mobile/v1/host-settings/mutate', hostSettings.handleHostSettingsMutate)
  route('/api/mobile/v1/llm/providers', hostSettings.handleLlmProviders)
  // 技能目录（宿主 skill.list 的移动端只读代理）。桌面端敲「/」时命令候选菜单里
  // 混着技能（@deepseek-ai/dsh-client-ui-skill 注册的 inputTriggers source），
  // 手机端此前只有 commands.list 的命令目录，技能一个都看不到，见 mobile/skills.js。
  route('/api/mobile/v1/skills', skills.handleSkills)
  // 宿主凭据（宿主 credentials.{describe,set,unset} 的移动端代理）。桌面端设置面板
  // 能往宿主写 API Key，手机端此前只能看到「1 项密钥未设置」却没有入口，见
  // mobile/credentials.js。密钥值只在这条路上出现一次，宿主从不回传值。
  route('/api/mobile/v1/credentials', mobileCredentials.handleCredentialsDescribe)
  route('/api/mobile/v1/credentials/set', mobileCredentials.handleCredentialsSet)
  route('/api/mobile/v1/credentials/unset', mobileCredentials.handleCredentialsUnset)
  // 子代理目录（宿主 subagent.list 的移动端只读代理）。桌面端会话标题栏挂着
  // 「N 个子代理」下拉，点进去能读子会话的完整记录；手机端把 origin === 'subagent'
  // 的行在侧栏里 continue 掉之后就再没有任何入口，见 mobile/subagents.js。
  route('/api/mobile/v1/subagents', subagents.handleSubagents)
  // 子代理续话与打断（宿主 subagent.prompt / subagent.interrupt 的移动端代理）。
  // 手机端的输入框只会发 session.send，而宿主对子会话一律回 agent-busy，所以给
  // 「可继续」子代理发消息必须换这条路由；一次性子代理宿主根本不收续话。
  route('/api/mobile/v1/subagents/prompt', subagents.handleSubagentPrompt)
  route('/api/mobile/v1/subagents/interrupt', subagents.handleSubagentInterrupt)
  // 引用发现（宿主 fileReferences.list / sessionReferenceResolver.candidates 的移动端
  // 代理）。桌面端输入 @ 会同时查这两个域，文件排在会话前面；手机端此前完全没有补全。
  // 和插件清单一样，这两个宿主服务不在 apiProxy 上，走 typertGateway，
  // 见 mobile/references.js。两个域各自独立降级，一个不可用不影响另一个。
  route('/api/mobile/v1/file-references', references.handleFileReferences)
  route('/api/mobile/v1/session-references', references.handleSessionReferences)

  // 桌面端 设置 → 插件 的只读部署快照，由 dsh-host-plugin-inventory 拥有，
  // 经 typertGateway 命名空间 pluginInventory 取，见 mobile/plugins.js。
  route('/api/mobile/v1/plugins', plugins.handlePlugins)

  // 内置浏览器预览（App 侧「点 localhost 链接在内置浏览器里打开」的宿主端一半）。
  //
  // 这是一条 **WebSocket 升级**路由，不是普通 HTTP 路由：手机原生模块按端口在环回监听、
  // 把 WebView 写下的原始字节塞进 WS 二进制帧；宿主这边 lib/relay/preview.js 完成握手后
  // 与 `127.0.0.1:<port>` 双向对搬。中转与局域网代理都**不用改**——中转的升级分发只看
  // 鉴权不看路径，局域网代理更是把任意升级路径原样转给宿主 webServer。
  //
  // 端口用查询串带（`?port=3001`）：宿主的升级匹配按 pathname 精确匹配、**忽略查询串**，
  // 所以下面这个不带查询串的字面量就是那条路由本身。
  //
  // 路径字面量必须与 App 侧 apiPaths.ts 的 preview 一致：test/mobile-routes.test.cjs
  // 就是拿这张表反向核对 App 常量表的。
  registerUpgradeRoute({ path: '/api/mobile/v1/preview', handler: preview.handleUpgrade })
}

module.exports = { registerMobileRoutes };