'use strict';

/**
 * 按设备发放的权限子集：权限位、档位、以及「移动路由 → 所需权限位」的分类表。
 *
 * 这是本次安全边界收紧的**唯一真源**：路由守卫按这里判位，配对档位按这里展开成权限数组，
 * 设备管理页按这里显示与降档。任何一处要「这条路由归哪一位」，都改这里，别散到别处。
 *
 * 边界口径（只收紧不放开）：
 *  - 凭据记录里**没有 `permissions` 字段 = 全权**。现网老凭据、升级前的老会话都缺这一格，
 *    一律按全权放行，行为与今天单 token 全给一字不差。
 *  - `permissions: []`（空数组）≠ 缺失：它是「明确什么都不给」，除下方 BASE 那几条保命接口
 *    （能连上、能自愈、能自己解绑、能升级）外全部 403。
 *  - 授权只能收窄：手机端只能在自己的当前权限里往下减（见 setDevicePermissions 的调用方），
 *    授予 / 提权只在电脑侧。
 *
 * 一个权限位 gate 一组路由。依赖关系（input→view、dispatch→view、files.write→files.read）
 * 由档位保证闭包完整（三档枚举本身自洽），运行时按位独立判定、不做隐式扩展；授予入口只收
 * 这三档枚举，没有别的写入路径，所以这里不加运行时闭包校验。
 *
 * 两条限制，摆明在头里：
 *  - 无记录的老凭据（升级前的 HMAC）按全权放行，且**无法被按设备降档** —— 它没有记录可写，
 *    要断只能吊销全部。
 *  - 可答审批档（approve）不等于无副作用：批一次能让模型在该会话里落地写动作，也能立一条
 *    长期自动放行规则。
 */

/** 十个权限位。只读类在前，方便肉眼对账。 */
const PERMISSIONS = Object.freeze({
  VIEW: 'view', // 看桌面快照、看会话内容与各种只读状态
  FILES_READ: 'files.read', // 读文件 / 目录 / 工作区 / git / 技能正文 / 画布只读
  INPUT: 'input', // 往会话注入输入、控制会话运行（发 / 停 / 改名 / 选模型 / 排队 / 已读）
  DISPATCH: 'dispatch', // 开新会话 / 派生分支 / 子代理 / 定时任务 / 取消后台任务
  APPROVE: 'approve', // 答审批、答提问 / 计划评审
  OPERATE: 'operate', // 让 AI 操作手机（动作通道 + 逐 App 访问 / 节奏设置 / 解绑）
  FILES_WRITE: 'files.write', // 写文件 / 目录 / 工作区 / git 写 / 技能写 / 画布写 / 收件箱清理
  TRANSFER: 'transfer', // 跨设备搬文件字节（上行分片 / 批量同步）
  MANAGE: 'manage', // 管权限本体：设备凭据（非自助）+ 中继配置 + 网页登录令牌
  CONFIG: 'config', // 宿主配置面：模型 / 渠道 / 插件 / API 密钥 / 预设 / 播报开关
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

/** 三档：配对时在电脑侧选定，展开成 permissions 数组存进凭据。 */
const TIERS = Object.freeze({
  readonly: [PERMISSIONS.VIEW, PERMISSIONS.FILES_READ],
  approve: [PERMISSIONS.VIEW, PERMISSIONS.FILES_READ, PERMISSIONS.APPROVE],
  full: ALL_PERMISSIONS.slice(),
});

const TIER_NAMES = Object.freeze(Object.keys(TIERS));
const DEFAULT_TIER = 'full';

function isKnownTier(tier) {
  return typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIERS, tier);
}

/** 档位 → 权限数组（未知 / 缺省一律回全权，向后兼容）。 */
function permissionsForTier(tier) {
  return isKnownTier(tier) ? TIERS[tier].slice() : TIERS.full.slice();
}

/**
 * 依赖关系表本身：`input→view`、`dispatch→view`、`files.write→files.read` 这类。
 * 只作为**声明**留在这里（档位是照它手写的三档枚举），生产代码不调用它；唯一的调用方是
 * 测试，用来证实三档枚举确实自洽。
 */
const DEPENDENCIES = Object.freeze({
  [PERMISSIONS.INPUT]: [PERMISSIONS.VIEW],
  [PERMISSIONS.DISPATCH]: [PERMISSIONS.VIEW],
  [PERMISSIONS.APPROVE]: [PERMISSIONS.VIEW],
  [PERMISSIONS.OPERATE]: [PERMISSIONS.VIEW],
  [PERMISSIONS.FILES_WRITE]: [PERMISSIONS.FILES_READ],
  [PERMISSIONS.TRANSFER]: [PERMISSIONS.FILES_WRITE],
});

function missingDependencies(permissions) {
  const set = new Set(Array.isArray(permissions) ? permissions : []);
  const missing = new Set();
  for (const [perm, deps] of Object.entries(DEPENDENCIES)) {
    if (!set.has(perm)) continue;
    for (const dep of deps) if (!set.has(dep)) missing.add(dep);
  }
  return [...missing];
}

/** 把任意输入规范化成一组已知权限位（去重、丢掉不认识的）。返回 { permissions, unknown }。 */
function normalizePermissionsInput(input) {
  const list = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const permissions = [];
  const unknown = [];
  for (const raw of list) {
    if (typeof raw !== 'string') { unknown.push(raw); continue; }
    const value = raw.trim();
    if (!ALL_PERMISSIONS.includes(value)) { unknown.push(raw); continue; }
    if (!permissions.includes(value)) permissions.push(value);
  }
  return { permissions, unknown };
}

/**
 * 「这条请求能不能做」。`record` 缺 `permissions`（老凭据）或没有记录（升级前 HMAC）都放行。
 * `permission` 为 null/空串（BASE 路由）也放行。
 */
function hasPermission(record, permission) {
  if (!permission) return true;
  // 没有记录 = 升级前 HMAC 那种无状态通行证，它本来就等于全权，不能一刀切拦住。
  if (!record || typeof record !== 'object') return true;
  const granted = record.permissions;
  // 字段缺失 / null = 全权（向后兼容的命门，别用 || 把空数组合成缺失）。
  if (!Array.isArray(granted)) return true;
  return granted.includes(permission);
}

/**
 * 移动路由 → 所需权限位。`null` 表示 BASE（鉴权通过即放行，不查权限位）。
 * 值是字符串，或 `{ GET, POST, DELETE, ... }` 形状（同路径按方法分读写）。
 *
 * 分类原则：只读 → view / files.read；有副作用 → 对应写位。BASE 只放「连上 / 自愈 /
 * 自助解绑 / 升级」这几条 —— 收窄权限不能把一台设备变成永远连不上的砖。
 */
const BASE = Object.freeze([
  '/api/mobile/v1/status',
  '/api/mobile/v1/connection-info',
  '/api/mobile/v1/tunnel',
  '/api/mobile/v1/p2p/rendezvous',
  '/api/mobile/v1/push-token',
  '/api/mobile/v1/perf-trace',
  '/api/mobile/v1/notification-prefs',
  '/api/mobile/v1/device-credential/revoke',
  '/api/mobile/v1/device-credential/upgrade',
  // 手机自助降档：任何已鉴权设备都能把自己的权限往下收 —— 收窄动作本身不该被收窄挡住。
  '/api/mobile/v1/device-credential/permissions',
]);

const V = PERMISSIONS;
const MAP = Object.freeze({
  // ── view：只读观察 ──────────────────────────────────────────────
  '/api/mobile/v1/sessions': V.VIEW,
  '/api/mobile/v1/monitor': V.VIEW,
  '/api/mobile/v1/session': V.VIEW,
  '/api/mobile/v1/session/messages': V.VIEW,
  // 历史 blob 的实例密钥（HK）：已配对设备的按需补发，纯只读。
  '/api/mobile/v1/history-key': V.VIEW,
  '/api/mobile/v1/session/step': V.VIEW,
  // 停止后的「本轮交代」：只读这一轮的步骤流、只算展示结构，能力面同 session/step。
  '/api/mobile/v1/session/stop-summary': V.VIEW,
  // 运行时间线：一轮跑过的每一步，只读历史与直播副本现折，不新增任何能力面。
  '/api/mobile/v1/session/run-timeline': V.VIEW,
  // 回答下面的来源行：只从这一轮的工具步里取网址 / 路径 / 查询词，只给指针不带正文。
  '/api/mobile/v1/session/answer-sources': V.VIEW,
  '/api/mobile/v1/session/delivery': V.VIEW,
  '/api/mobile/v1/session/artifacts': V.VIEW,
  '/api/mobile/v1/session/archive': V.VIEW,
  '/api/mobile/v1/session/head': V.VIEW,
  '/api/mobile/v1/session/models': V.VIEW,
  '/api/mobile/v1/session/stats': V.VIEW,
  '/api/mobile/v1/session/search': V.VIEW,
  '/api/mobile/v1/session/stream': V.VIEW,
  '/api/mobile/v1/events/stream': V.VIEW,
  '/api/mobile/v1/session-log': V.VIEW,
  '/api/mobile/v1/commands': V.VIEW,
  '/api/mobile/v1/subagents': V.VIEW,
  '/api/mobile/v1/stats/overview': V.VIEW,
  '/api/mobile/v1/agent-presets': V.VIEW,
  '/api/mobile/v1/agent-presets/read': V.VIEW,
  '/api/mobile/v1/schedule/catalog': V.VIEW,
  '/api/mobile/v1/schedule/list': V.VIEW,
  '/api/mobile/v1/schedule/history': V.VIEW,
  '/api/mobile/v1/inbox/status': V.VIEW,
  '/api/mobile/v1/inbox/clear': V.FILES_WRITE,
  '/api/mobile/v1/inbox/auto': V.CONFIG,
  '/api/mobile/v1/file-references': V.VIEW,
  '/api/mobile/v1/session-references': V.VIEW,
  '/api/mobile/v1/deepseek-account': V.VIEW,
  '/api/mobile/v1/model-meta': V.VIEW,
  '/api/mobile/v1/model-meta/apply': V.CONFIG,
  '/api/mobile/v1/llm/providers': V.VIEW,
  '/api/mobile/v1/llm/models': V.VIEW,
  '/api/mobile/v1/host-settings': { GET: V.VIEW, POST: V.CONFIG },
  '/api/mobile/v1/host-settings/mutate': V.CONFIG,
  '/api/mobile/v1/channels': V.VIEW,
  '/api/mobile/v1/channels/discover': V.CONFIG,
  '/api/mobile/v1/channels/save': V.CONFIG,
  '/api/mobile/v1/channels/delete': V.CONFIG,
  '/api/mobile/v1/plugins': V.VIEW,
  '/api/mobile/v1/skills': V.VIEW,
  '/api/mobile/v1/narration': { GET: V.VIEW, POST: V.FILES_WRITE },
  '/api/mobile/v1/extension/cards': V.VIEW,
  '/api/mobile/v1/extension/card-state': { GET: V.VIEW, POST: V.FILES_WRITE },
  '/api/mobile/v1/extension/data': V.VIEW,
  '/api/mobile/v1/extension/catalog': V.VIEW,
  '/api/mobile/v1/extension/catalog/file': V.VIEW,
  '/api/mobile/v1/extension/catalog/archive': V.FILES_WRITE,
  '/api/mobile/v1/extension/dev/packages': V.VIEW,
  '/api/mobile/v1/extension/dev/file': V.VIEW,
  // 开发包的整包与官方那一档同权：取整包就是「把一整个包装到手机上」，不是只读。
  '/api/mobile/v1/extension/dev/archive': V.FILES_WRITE,
  '/api/mobile/v1/extension/action': V.FILES_WRITE,
  '/api/mobile/v1/pet/packs': V.VIEW,
  '/api/mobile/v1/pet/pack/file': V.VIEW,
  '/api/mobile/v1/pet/pack/delete': V.FILES_WRITE,
  // 中继配置：GET 只读自查（diagnostics / probe / check-port 同理），POST 走的是保存
  // （handleRelayConfig 按方法分派到 handleRelayConfigSave：改中转地址、注册密钥、配对策略），
  // 那是 manage 级配置，与下文的 `/relay/config/save` 同档。
  '/api/mobile/v1/relay/config': { GET: V.VIEW, POST: V.MANAGE },
  '/api/mobile/v1/relay/diagnostics': V.VIEW,
  '/api/mobile/v1/relay/probe': V.VIEW,
  '/api/mobile/v1/relay/check-port': V.VIEW,
  // 插件市场只读浏览
  '/api/mobile/v1/plugin/market': V.VIEW,
  '/api/mobile/v1/plugin/market/registries': V.VIEW,
  '/api/mobile/v1/plugin/market/detail': V.VIEW,
  '/api/mobile/v1/plugin/market/inspect': V.VIEW,
  '/api/mobile/v1/plugin/market/progress': V.VIEW,
  '/api/mobile/v1/plugin/update/status': V.VIEW,
  '/api/mobile/v1/plugin/update/check': V.VIEW,
  '/api/mobile/v1/plugin/self': V.VIEW,

  // ── files.read：读文件 / 目录 / 工作区 / git / 技能正文 ─────────
  '/api/mobile/v1/file/read': V.FILES_READ,
  '/api/mobile/v1/directory/list': V.FILES_READ,
  '/api/mobile/v1/directory/roots': V.FILES_READ,
  '/api/mobile/v1/directory/listing': V.FILES_READ,
  '/api/mobile/v1/workspaces': V.FILES_READ,
  '/api/mobile/v1/git/repo': V.FILES_READ,
  '/api/mobile/v1/git/status': V.FILES_READ,
  '/api/mobile/v1/git/diff': V.FILES_READ,
  '/api/mobile/v1/git/log': V.FILES_READ,
  '/api/mobile/v1/git/show': V.FILES_READ,
  '/api/mobile/v1/git/branches': V.FILES_READ,
  '/api/mobile/v1/git/overview': V.FILES_READ,
  '/api/mobile/v1/git/commit-message': V.FILES_READ,
  // GitHub PR 那一层：只读列表 / 检查 / 评论归读；标 ready 与合并会真的动远端仓库，归 git 写。
  '/api/mobile/v1/git/prs': { GET: V.FILES_READ, POST: V.FILES_WRITE },
  '/api/mobile/v1/git/pr/checks': V.FILES_READ,
  '/api/mobile/v1/git/pr/comments': { GET: V.FILES_READ, POST: V.FILES_WRITE },
  '/api/mobile/v1/git/pr/ready': V.FILES_WRITE,
  '/api/mobile/v1/git/pr/merge': V.FILES_WRITE,
  '/api/mobile/v1/session/file': V.FILES_READ,
  '/api/mobile/v1/session/attachment': V.FILES_READ,
  '/api/mobile/v1/session/local-image': V.FILES_READ,
  '/api/mobile/v1/skill/list': V.FILES_READ,
  '/api/mobile/v1/skill/content': V.FILES_READ,
  '/api/mobile/v1/skill/trash': { GET: V.FILES_READ, POST: V.FILES_READ },

  // ── input：会话输入 / 控制 ─────────────────────────────────────
  '/api/mobile/v1/session/send': V.INPUT,
  '/api/mobile/v1/session/stop': V.INPUT,
  '/api/mobile/v1/session/rename': V.INPUT,
  '/api/mobile/v1/session/read': V.INPUT,
  '/api/mobile/v1/session/select-model': V.INPUT,
  '/api/mobile/v1/session/model-option': V.INPUT,
  // 会话级「启用智能体团队协作」：写的是这条会话自己的日志（宿主 agentTeams.setEnabled），
  // 与会话控制同一档；视图档只看得到开关状态、点不动它。
  '/api/mobile/v1/session/team-mode': V.INPUT,
  '/api/mobile/v1/session/goal': V.INPUT,
  '/api/mobile/v1/session/queue/update': V.INPUT,

  // ── dispatch：派任务 / 开新会话 / 定时 / 取消后台 ──────────────
  '/api/mobile/v1/session/new': V.DISPATCH,
  '/api/mobile/v1/session/fork': V.DISPATCH,
  '/api/mobile/v1/subagents/prompt': V.DISPATCH,
  '/api/mobile/v1/subagents/interrupt': V.DISPATCH,
  '/api/mobile/v1/schedule/create': V.DISPATCH,
  '/api/mobile/v1/schedule/update': V.DISPATCH,
  '/api/mobile/v1/schedule/delete': V.DISPATCH,
  '/api/mobile/v1/schedule/pause': V.DISPATCH,
  '/api/mobile/v1/schedule/resume': V.DISPATCH,
  '/api/mobile/v1/schedule/run': V.DISPATCH,
  '/api/mobile/v1/jobs/cancel': V.DISPATCH,
  '/api/mobile/v1/jobs/start': V.DISPATCH, // 恒 501，仍登记以保分类完整

  // ── approve：答审批 / 答提问 ───────────────────────────────────
  '/api/mobile/v1/approval/respond': V.APPROVE,
  '/api/mobile/v1/question/respond': V.APPROVE,
  // 审批自动放行规则（读规则 / 撤销某条规则）：读归 view，改归 approve ——「这台设备能不能
  // 自己定自动放行」属于审批权限本身，不是普通配置。
  '/api/mobile/v1/approval/rules': { GET: V.VIEW, POST: V.APPROVE },
  '/api/mobile/v1/approval/rules/revoke': V.APPROVE,

  // ── 预览：WebSocket 升级路由 ─────────────────────────────────
  // 它不经过 `guarded`（升级请求要的是一次拒绝或一次握手，不是 JSON 信封），校验写在
  // relay/preview.js 的 `handleUpgrade` 里，用的仍是这张表。登记在这里，是为了让
  // 「每条注册的路由都被权限表覆盖」那条守卫能看见它。
  // 内置浏览器预览：手机点一个 localhost 链接、把这台电脑上的某个本地端口接进内置浏览器。
  // 它是**看**（用户点开一页），归 view：三档里只读与可答审批都带 view，行为不变；真正被
  // 这条关掉的是 `permissions: []` 那种「明确什么都不给」的设备 —— 它们原来也能连上来。
  // 它能拨到哪儿另有独立的边界（protectedPorts / webapp 那一档，见 relay/preview.js）。
  '/api/mobile/v1/preview': V.VIEW,

  // ── files.write：写文件 / 工作区 / git 写 / 技能写 / 画布写 ─────
  '/api/mobile/v1/file/create': V.FILES_WRITE,
  '/api/mobile/v1/file/delete': V.FILES_WRITE,
  '/api/mobile/v1/file/rename': V.FILES_WRITE,
  '/api/mobile/v1/directory/create': V.FILES_WRITE,
  // 项目写入队列的暂停 / 恢复：只切插件自己的队列开关，**一个文件都不写**，所以 POST 也算
  // view（给 files.write 会把只读设备挡在一件它本来就做不了的事之外，没有收益）。
  '/api/mobile/v1/project/writes': { GET: V.VIEW, POST: V.VIEW },
  '/api/mobile/v1/workspace/create': V.FILES_WRITE,
  '/api/mobile/v1/workspace/delete': V.FILES_WRITE,
  '/api/mobile/v1/workspace/move': V.FILES_WRITE,
  '/api/mobile/v1/workspace/move-session': V.FILES_WRITE,
  '/api/mobile/v1/workspace/rename': V.FILES_WRITE,
  '/api/mobile/v1/workspace/archive-session': V.FILES_WRITE,
  '/api/mobile/v1/workspace/unarchive-session': V.FILES_WRITE,
  '/api/mobile/v1/workspace/pin-session': V.FILES_WRITE,
  '/api/mobile/v1/workspace/unpin-session': V.FILES_WRITE,
  '/api/mobile/v1/workspace/clear-archived': V.FILES_WRITE,
  '/api/mobile/v1/git/stage': V.FILES_WRITE,
  '/api/mobile/v1/git/unstage': V.FILES_WRITE,
  '/api/mobile/v1/git/commit': V.FILES_WRITE,
  '/api/mobile/v1/git/checkout': V.FILES_WRITE,
  '/api/mobile/v1/git/push': V.FILES_WRITE,
  '/api/mobile/v1/skill/create': V.FILES_WRITE,
  '/api/mobile/v1/skill/save': V.FILES_WRITE,
  '/api/mobile/v1/skill/delete': V.FILES_WRITE,
  '/api/mobile/v1/skill/trash/restore': V.FILES_WRITE,

  // ── transfer：传文件 ──────────────────────────────────────────
  '/api/mobile/v1/upload/begin': V.TRANSFER,
  '/api/mobile/v1/upload/chunk': V.TRANSFER,
  '/api/mobile/v1/upload/finish': V.TRANSFER,
  '/api/mobile/v1/upload/abort': V.TRANSFER,
  '/api/mobile/v1/sync/tickets': V.TRANSFER,
  '/api/mobile/v1/sync/inbox': V.TRANSFER,

  // ── manage：设备凭据本体 + 中继配置 + 网页登录令牌 ─────────────
  '/api/mobile/v1/relay/config/save': V.MANAGE,
  '/api/mobile/v1/relay/enabled': V.MANAGE,
  '/api/mobile/v1/relay/pairing-code': V.MANAGE,
  '/api/mobile/v1/relay/revoke-all': V.MANAGE,
  '/api/mobile/v1/relay/reconnect': V.MANAGE,
  '/api/mobile/v1/relay/restart-sidecar': V.MANAGE,
  '/api/mobile/v1/host-web': V.MANAGE,

  // ── config：宿主配置面（模型 / 渠道 / 插件 / 密钥 / 预设）─────────
  '/api/mobile/v1/credentials/set': V.CONFIG,
  '/api/mobile/v1/credentials/unset': V.CONFIG,
  '/api/mobile/v1/credentials': { GET: V.VIEW, POST: V.CONFIG },
  '/api/mobile/v1/plugin/self/auto': V.CONFIG,
  // 「DSH 插件市场」的清单：只读一份社区公开 JSON、只算 installSpec，不装不卸、不写盘，
  // 所以归读。装的动作仍走下面那几条 market 路由（CONFIG）。
  '/api/mobile/v1/plugin/catalog': V.VIEW,
  '/api/mobile/v1/plugin/market/install': V.CONFIG,
  '/api/mobile/v1/plugin/market/remove': V.CONFIG,
  '/api/mobile/v1/plugin/market/update': V.CONFIG,
  '/api/mobile/v1/plugin/market/cancel': V.CONFIG,
  '/api/mobile/v1/plugin/market/enabled': V.CONFIG,
  '/api/mobile/v1/plugin/update/apply': V.CONFIG,
  '/api/mobile/v1/agent-presets/copy': V.CONFIG,
  '/api/mobile/v1/agent-presets/remove': V.CONFIG,
  '/api/mobile/v1/agent-presets/default': V.CONFIG,
  '/api/mobile/v1/magpie/web': V.CONFIG,
});

const BASE_SET = new Set(BASE);

/**
 * 去掉查询串与末尾斜杠、并剥掉部署前缀，得到用于查表的 pathname。
 *
 * 锚到 `/api/mobile/v1/` 这一段的理由：守卫拿到的是原始 `req.url`，而请求签名用的是从这段
 * 起算的剥前缀路径（见 `shared/e2ee-request.js` 的 `signedPath`）。两处用两套口径时，部署
 * 带前缀（`/deploy/api/mobile/v1/...`）会让所有路由都对不上表、被判成未分类而 403。
 * 找不到这段就按原样返回，与 `signedPath` 一致。
 */
function pathnameOf(path) {
  if (typeof path !== 'string' || !path) return '';
  const q = path.indexOf('?');
  let p = q >= 0 ? path.slice(0, q) : path;
  const h = p.indexOf('#');
  if (h >= 0) p = p.slice(0, h);
  const base = '/api/mobile/v1/';
  const hit = p.indexOf(base);
  if (hit >= 0) p = p.slice(hit);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * 解析一条移动路由所需的权限位。
 * 返回 `null`（BASE，不查权限）/ 权限位字符串 / `'unknown'`（没分类，调用方应 fail-closed）。
 */
function resolvePermission(path, method = 'GET') {
  const name = pathnameOf(path);
  if (BASE_SET.has(name)) return null;
  const entry = MAP[name];
  if (entry === undefined) return 'unknown';
  if (typeof entry === 'string') return entry;
  const verb = String(method || 'GET').toUpperCase();
  if (entry[verb] !== undefined) return entry[verb];
  // 同路径不同方法没单独列的兜底：GET 归读、其余按写（宁可严）。
  if (entry.GET !== undefined && verb === 'GET') return entry.GET;
  return entry.POST !== undefined ? entry.POST : (entry.GET !== undefined ? entry.GET : 'unknown');
}

/**
 * 预览这条 WebSocket 升级路由用的权限判定三件套。
 *
 * 这两条是 WebSocket 升级，不过 `guarded`（升级请求要的是一次拒绝或一次握手，不是 JSON
 * 信封），但「谁都能连」不是选项。所以把 `guarded` 里同一套判定（同一个 `resolve` /
 * `has`）单独包一份给它们的服务用；`recordOf` 按请求出示的凭据取记录，与 guarded 里挂
 * `req.__dshRecord` 是同一个查法。装配层只传四个已存在的东西，判断逻辑不生第二份。
 *
 * @param {{ credentials: object, instanceId: string, presentedCredential: (req) => string|null }} deps
 */
function createUpgradePermission({ credentials, instanceId, presentedCredential } = {}) {
  return {
    resolve: resolvePermission,
    has: hasPermission,
    recordOf: (req) => {
      if (!credentials || typeof credentials.lookup !== 'function') return null;
      let presented = null;
      try { presented = presentedCredential ? presentedCredential(req) : null; } catch { presented = null; }
      return presented ? credentials.lookup(presented, instanceId) : null;
    },
  };
}

/** 该 path 是否已被分类（BASE 或 MAP）。测试用来钉「没有漏网路由」。 */
function isClassified(path) {
  const name = pathnameOf(path);
  return BASE_SET.has(name) || MAP[name] !== undefined;
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  TIERS,
  TIER_NAMES,
  DEFAULT_TIER,
  DEPENDENCIES,
  isKnownTier,
  permissionsForTier,
  missingDependencies,
  normalizePermissionsInput,
  hasPermission,
  resolvePermission,
  createUpgradePermission,
  isClassified,
  pathnameOf,
};
