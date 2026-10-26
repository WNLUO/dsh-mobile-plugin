'use strict';

/**
 * 移动端「插件管理」：这台电脑上 DSH 装了哪些插件、装 / 卸 / 启用 / 升级。
 *
 * 不自己跑包管理器：DSH 宿主里本来就有一套插件管理器（`pluginManager` 服务，桌面端
 * 设置 → 插件 那个页面就是它的界面），装包、版本兼容检查、依赖脚本授权、装失败回滚、
 * 「要不要重启才生效」全由它判断。这里只做三件事：把它的结果削成手机要的形状、把手机
 * 发来的动作转过去、把一次安装的进度留在内存里给轮询。
 *
 * 能力面收在三条上（与桌面端同一个判据，不另开）：
 *  1. **只经 typertGateway 走 `pluginManager`**，不走 shell、不碰系统设置；
 *  2. **承载本 App 连接的那个包（dsh-mobile-plugin）不给卸载、不给停用**：卸载它等于把这
 *     台手机变成砖，而手机没有在电脑前的那双手；更新它仍走原有的 `/plugin/update/*`（那条
 *     有装后自检与回滚，比通用卸载可靠）；
 *  3. 安装/卸载**不改 DSH 的启动方式**：新装的插件要不要重启才生效由宿主自己回报，界面照实说。
 *
 * 接口（都挂 `/api/mobile/v1/plugin/market`，走 token 守卫）：
 *  GET  `/plugin/market`            → { bundles }
 *  POST `/plugin/market/inspect`    { spec } → 读一下这个包是什么
 *  POST `/plugin/market/install`    { spec, requestId? } → 开始装（立即返回）
 *  POST `/plugin/market/update`     { name, requestId? } → 卸载后重装成最新 / 官方给的目标版本
 *  POST `/plugin/market/cancel`     { requestId } → 停一次正在跑的安装
 *  GET  `/plugin/market/progress?requestId=` → 那一次装完没有
 *  POST `/plugin/market/remove`     { name, confirm } → 卸载
 *  POST `/plugin/market/enabled`    { name, enabled } → 启用 / 停用（依赖留着）
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { invoke, UNAVAILABLE: GATEWAY_UNAVAILABLE } = require('./host-bridge/transport.js');
const pkg = require('../../package.json');

/** 缺了插件管理器（老宿主 / 极简 profile）：对客户端就是「这台没有这个能力」。 */
const UNAVAILABLE = Object.freeze({
  code: 'plugin-market-unavailable',
  message: '这台宿主的版本太旧，没有插件管理服务；请到电脑上的 DSH 里管理插件',
});

/** 承载 App 连接的那个包：只可更新，不可卸载 / 停用。 */
const SELF_NAME = pkg.name;

const SPEC_MAX_CHARS = 300;
const NAME_MAX_CHARS = 300;
const REQUEST_ID_MAX_CHARS = 120;
const BUNDLES_MAX_ITEMS = 300;
/** 内存里最多留几条安装记录：手机只会盯手上这一条，多的是断线前留下的。 */
const TASKS_MAX = 20;
const BODY_MAX_BYTES = 8 * 1024;

/** 安装结果里对手机有意义的几格（宿主的 `application` / `stage` / `error` 原样透出）。 */
const APPLICATIONS = new Set(['cancelled', 'failed', 'applied', 'restart-required', 'overridden']);
const RESTART_REASONS = new Set(['no-hmr', 'package-moved', 'host-module', 'unmanaged-plugin', 'module-comparison']);

/** 一次安装的进度账（只活在本进程里；宿主重启后手机按 unknown 处理，重新读列表）。 */
const tasks = new Map();

function textOrNull(value, max = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/** 网关 / 服务缺失统一回同一个码，客户端据此说「这台宿主版本太旧」。 */
function normalizeCallError(error) {
  if (!error) return { ...UNAVAILABLE };
  if (error.code === GATEWAY_UNAVAILABLE.code || error.code === UNAVAILABLE.code) return { ...UNAVAILABLE };
  const code = typeof error.code === 'string' && error.code ? error.code : 'plugin-market-failed';
  return { code, message: errorText(error) };
}

function statusOf(error) {
  return error && error.code === UNAVAILABLE.code ? 503 : 400;
}

/** 调一次插件管理器。args 的键名必须与宿主 descriptor 逐字一致（多一个少一个都 400）。 */
async function call(ctx, method, args, signal) {
  const result = await invoke(ctx, 'pluginManager', method, args || {}, signal);
  return result.error ? { error: normalizeCallError(result.error) } : { value: result.value };
}

/**
 * 一次管理动作的结果投影。
 *
 * `application` 说这一步到底生效没有：`applied` 当场生效、`restart-required` 要等电脑上
 * 下次启动 DSH、`failed` 失败、`cancelled` 被取消。手机不做二次判断，照它说。
 */
function operationView(value) {
  if (!value || typeof value !== 'object') return null;
  const error = value.error && typeof value.error === 'object'
    ? {
      code: textOrNull(value.error.code, 64) || 'operation-error',
      message: typeof value.error.diagnostic === 'string' && value.error.diagnostic
        ? value.error.diagnostic
        : '',
    }
    : null;
  return {
    changed: value.changed === true,
    application: APPLICATIONS.has(value.application) ? value.application : 'failed',
    restartReason: RESTART_REASONS.has(value.restartReason) ? value.restartReason : null,
    stage: textOrNull(value.stage, 16),
    target: textOrNull(value.target, NAME_MAX_CHARS),
    version: textOrNull(value.version, 64),
    pendingBuilds: Array.isArray(value.pendingBuilds)
      ? value.pendingBuilds.filter((name) => typeof name === 'string').slice(0, 20)
      : [],
    error,
  };
}

/** 显示名：宿主给的 meta 是「一句话或多语言表」，两种都原样转给 App 由它按语言挑。 */
function displayField(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function normalizeBundle(row) {
  if (!row || typeof row !== 'object') return null;
  const name = textOrNull(row.name, NAME_MAX_CHARS);
  if (!name) return null;
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : null;
  const installTarget = row.installTarget && typeof row.installTarget === 'object'
    ? { spec: textOrNull(row.installTarget.spec, SPEC_MAX_CHARS), version: textOrNull(row.installTarget.version, 64) }
    : null;
  const error = row.error && typeof row.error === 'object'
    ? {
      code: textOrNull(row.error.code, 64) || 'operation-error',
      message: typeof row.error.diagnostic === 'string' && row.error.diagnostic
        ? row.error.diagnostic
        : '',
    }
    : null;
  return {
    name,
    version: textOrNull(row.version, 64),
    title: meta ? displayField(meta.title) : null,
    description: (meta ? displayField(meta.description) : null) || textOrNull(row.description, 400),
    source: textOrNull(row.source, SPEC_MAX_CHARS),
    enabled: row.enabled === true,
    installed: row.installed === true,
    official: row.official === true,
    optional: row.optional === true,
    removable: row.removable === true,
    availability: textOrNull(row.availability, 16),
    installTarget: installTarget && installTarget.spec ? installTarget : null,
    /** 承载 App 连接的自己：卸载 / 停用一律拒绝，只留更新（见文件头）。 */
    protectedSelf: name === SELF_NAME,
    rowCount: Array.isArray(row.rows) ? row.rows.length : 0,
    error: error || (textOrNull(row.readOnlyReason, 32) ? { code: textOrNull(row.readOnlyReason, 32), message: '' } : null),
  };
}

function pruneTasks() {
  if (tasks.size <= TASKS_MAX) return;
  const done = [...tasks.entries()]
    .filter(([, task]) => task.state !== 'running')
    .sort((a, b) => a[1].startedAt - b[1].startedAt);
  for (const [id] of done) {
    tasks.delete(id);
    if (tasks.size <= TASKS_MAX) break;
  }
}

/** 新开一条安装记录：同一个 requestId 重复进来时覆盖上一条（手机重发就是重来一次）。 */
function beginTask(requestId, kind, target) {
  const task = { requestId, kind, target, state: 'running', result: null, startedAt: Date.now() };
  tasks.set(requestId, task);
  pruneTasks();
  return task;
}

function finishTask(requestId, result) {
  const task = tasks.get(requestId);
  if (!task) return;
  task.state = 'done';
  task.result = result;
  task.finishedAt = Date.now();
}

/** requestId 缺省时由宿主取：手机那条路一般自己带，重发时才好对账。 */
function readRequestId(value, fallback) {
  const text = textOrNull(value, REQUEST_ID_MAX_CHARS);
  return text || fallback();
}

let counter = 0;
function localRequestId(prefix) {
  counter += 1;
  return `mobile-${prefix}-${Date.now()}-${counter}`;
}

function badRequest(res, message) {
  return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message } });
}

function normalizeSpec(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { problem: '需要包名（也可以填 Git 地址或提示里的安装命令）' };
  if (text.length > SPEC_MAX_CHARS) return { problem: `包名太长（上限 ${SPEC_MAX_CHARS} 个字符）` };
  if (/[\r\n\t]/.test(text)) return { problem: '包名里不能有换行或制表符' };
  return { value: text };
}

function normalizeName(value) {
  const text = textOrNull(value, NAME_MAX_CHARS);
  if (!text) return { problem: '需要插件包名' };
  if (/[\r\n\t]/.test(text)) return { problem: '包名里不能有换行或制表符' };
  return { value: text };
}

/**
 * 升级这一步的目标：官方按需插件由宿主给出**确切**的 installTarget（版本钉死在运行中的
 * DSH 上）；第三方插件回到注册表最新的同名包。`file:` / `link:` / git 地址这类来源没有
 * 「最新版」可言，如实拒绝，让用户回电脑上换来源。
 */
/**
 * 从一条依赖声明里取回 npm 包名：`name@^1.2.3` / `@scope/name@~2` / 别名都收，纯版本范围
 * （`^1.2.0` / `latest` / `*`）回落到包自己的名字。
 */
function registryNameOf(source, fallback) {
  const value = String(source || '').trim();
  if (!value) return fallback;
  if (/^(?:[\^~<>=*]|\d|latest$|next$|beta$|alpha$|rc$)/i.test(value)) return fallback;
  const at = value.startsWith('@') ? value.indexOf('@', 1) : value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}

function updateTargetOf(bundle) {
  if (!bundle) return { problem: '这台宿主上没有这个插件' };
  // 自己那条更新路不在这里：`/plugin/update/*` 有装前备份、装后自检与回滚，而通用那条
  // 是先卸载再装 —— 一旦装坏，手机连发一句话的机会都没有。
  if (bundle.name === SELF_NAME) return { problem: '这个插件要在「版本与更新」那一块更新（那条会自检、失败会自己退回）' };
  if (bundle.installTarget && bundle.installTarget.spec) return { spec: bundle.installTarget.spec };
  const source = bundle.source || '';
  if (!source) return { problem: '这个插件的来源不是一个可以从 npm 升级的名字；要换版本请在电脑上重装' };
  if (/^(?:file|link|workspace|git|github|gitlab|bitbucket|https?):/i.test(source) || /^\.{0,2}\//.test(source)) {
    return { problem: '这个插件是从本地目录或压缩包/仓库装的，没有「最新版」可升；要换版本请在电脑上重装' };
  }
  // 依赖声明里的 npm spec：宿主的 `source` 可能是「name@^1.2.3」这种整条 spec，也可能只是
  // 版本范围 / 标签（`^1.2.0`、`latest`）—— 后者按包本身的 name 走。
  return { spec: registryNameOf(source, bundle.name) };
}

/**
 * GET /api/mobile/v1/plugin/market
 * 成功：{ ok:true, bundles:[...] }；宿主没有插件管理器时 503。
 */
async function handlePluginMarket(ctx, _req, res) {
  const result = await call(ctx, 'listBundles', {});
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const raw = Array.isArray(result.value) ? result.value : [];
  const bundles = [];
  for (const row of raw) {
    const bundle = normalizeBundle(row);
    if (!bundle) continue;
    bundles.push(bundle);
    if (bundles.length >= BUNDLES_MAX_ITEMS) break;
  }
  sendJson(res, 200, { ok: true, bundles, self: SELF_NAME });
}

/**
 * POST /api/mobile/v1/plugin/market/inspect  { spec }
 * 装之前先问一句「这个 spec 是什么」：包名、版本、一句话、有没有插件本体。
 */
async function handlePluginMarketInspect(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const spec = normalizeSpec(body && body.spec);
  if (!spec.value) return badRequest(res, spec.problem);
  const result = await call(ctx, 'inspect', { spec: spec.value });
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  if (value.status !== 'accepted') {
    return sendJson(res, 200, {
      ok: true,
      accepted: false,
      problem: textOrNull(value.problem, 32) || 'unknown',
      reason: typeof value.reason === 'string' ? value.reason : '',
      registries: Array.isArray(value.registries) ? value.registries.filter((item) => typeof item === 'string') : [],
    });
  }
  sendJson(res, 200, {
    ok: true,
    accepted: true,
    kind: textOrNull(value.kind, 16),
    name: textOrNull(value.name, NAME_MAX_CHARS),
    version: textOrNull(value.version, 64),
    description: textOrNull(value.description, 400),
    bundle: value.bundle === true,
    registry: textOrNull(value.registry, 300),
    host: textOrNull(value.host, 200),
  });
}

/**
 * POST /api/mobile/v1/plugin/market/install  { spec, requestId?, approvedBuilds? }
 * 立即返回 `{ ok:true, requestId }`；装没装完由 `/progress` 问。装一次可能几十秒到几分钟，
 * 手机上不该挂一条长请求等它。
 */
async function handlePluginMarketInstall(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const spec = normalizeSpec(body && body.spec);
  if (!spec.value) return badRequest(res, spec.problem);
  const approvedBuilds = Array.isArray(body && body.approvedBuilds)
    ? body.approvedBuilds.filter((name) => typeof name === 'string' && name.trim()).slice(0, 40)
    : [];
  const requestId = readRequestId(body && body.requestId, () => localRequestId('install'));
  beginTask(requestId, 'install', spec.value);
  // 不在请求里等：宿主的 installBundle 是长任务，手机断线/切后台不该把它拖断。
  void (async () => {
    const options = { requestId, enabled: true };
    if (approvedBuilds.length) options.approvedBuilds = approvedBuilds;
    const result = await call(ctx, 'installBundle', { spec: spec.value, options });
    finishTask(requestId, result.error
      ? { ok: false, error: result.error }
      : { ok: true, operation: operationView(result.value), spec: spec.value });
  })();
  sendJson(res, 202, { ok: true, requestId });
}

/**
 * POST /api/mobile/v1/plugin/market/update  { name, requestId? }
 * 升级 = **卸载再装**（DSH 自己的规矩：第三方插件没有原地换代，官方按需插件则由宿主
 * 给出确切目标版本）。失败时插件会停在「已卸载」，界面必须把这一点写在确认框里。
 */
async function handlePluginMarketUpdate(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const name = normalizeName(body && body.name);
  if (!name.value) return badRequest(res, name.problem);
  const listed = await call(ctx, 'listBundles', {});
  if (listed.error) return sendJson(res, statusOf(listed.error), { ok: false, error: listed.error });
  const bundle = Array.isArray(listed.value) ? listed.value.map(normalizeBundle).find((item) => item && item.name === name.value) : null;
  const target = updateTargetOf(bundle);
  if (target.problem) return sendJson(res, 400, { ok: false, error: { code: 'no-update-target', message: target.problem } });
  const requestId = readRequestId(body && body.requestId, () => localRequestId('update'));
  beginTask(requestId, 'update', target.spec);
  void (async () => {
    const removed = await call(ctx, 'removeBundle', { name: name.value });
    if (removed.error) {
      finishTask(requestId, { ok: false, error: removed.error, stage: 'remove' });
      return;
    }
    const removedView = operationView(removed.value);
    if (removedView && (removedView.application === 'failed' || removedView.application === 'cancelled')) {
      finishTask(requestId, { ok: true, operation: removedView, stage: 'remove' });
      return;
    }
    const installed = await call(ctx, 'installBundle', { spec: target.spec, options: { requestId, enabled: true } });
    finishTask(requestId, installed.error
      ? { ok: false, error: installed.error, stage: 'install' }
      : { ok: true, operation: operationView(installed.value), spec: target.spec, stage: 'install' });
  })();
  sendJson(res, 202, { ok: true, requestId, spec: target.spec });
}

/**
 * GET /api/mobile/v1/plugin/market/progress?requestId=
 * `state`：running（还在装）/ done（附 result）/ unknown（本进程没有这条记录，多半是宿主重启过）。
 */
async function handlePluginMarketProgress(_ctx, req, res) {
  const params = new URL(req.url || '/', 'http://x').searchParams;
  const requestId = textOrNull(params.get('requestId'), REQUEST_ID_MAX_CHARS);
  if (!requestId) return badRequest(res, '需要 requestId');
  const task = tasks.get(requestId);
  if (!task) return sendJson(res, 200, { ok: true, state: 'unknown' });
  if (task.state === 'running') return sendJson(res, 200, { ok: true, state: 'running', kind: task.kind });
  sendJson(res, 200, { ok: true, state: 'done', kind: task.kind, result: task.result });
}

/** POST /api/mobile/v1/plugin/market/cancel  { requestId } → { status } */
async function handlePluginMarketCancel(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const requestId = textOrNull(body && body.requestId, REQUEST_ID_MAX_CHARS);
  if (!requestId) return badRequest(res, '需要 requestId');
  const result = await call(ctx, 'cancelInstall', { requestId });
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const status = result.value && typeof result.value === 'object' ? textOrNull(result.value.status, 16) : null;
  sendJson(res, 200, { ok: true, status: status || 'not-running' });
}

/**
 * POST /api/mobile/v1/plugin/market/remove  { name, confirm }
 * `confirm` 必须为 true：卸载会让那个插件下次启动就不在了，手机上不能靠一次误触发生。
 */
async function handlePluginMarketRemove(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const name = normalizeName(body && body.name);
  if (!name.value) return badRequest(res, name.problem);
  if ((body && body.confirm) !== true) return badRequest(res, '卸载要带 confirm: true');
  if (name.value === SELF_NAME) {
    return sendJson(res, 403, {
      ok: false,
      error: {
        code: 'self-protected',
        message: '这个插件承载手机连上来的那条连接，卸载后这台手机就再也联不上了。要更新它请用设备 → 插件页的「立即更新」',
      },
    });
  }
  const result = await call(ctx, 'removeBundle', { name: name.value });
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  sendJson(res, 200, { ok: true, operation: operationView(result.value) });
}

/** POST /api/mobile/v1/plugin/market/enabled  { name, enabled } */
async function handlePluginMarketEnabled(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const name = normalizeName(body && body.name);
  if (!name.value) return badRequest(res, name.problem);
  const enabled = body && body.enabled === true;
  if (name.value === SELF_NAME && enabled !== true) {
    return sendJson(res, 403, {
      ok: false,
      error: {
        code: 'self-protected',
        message: '关掉这个插件等于断开这台手机；要停用到电脑上的设置里操作',
      },
    });
  }
  const result = await call(ctx, 'setBundleEnabled', { name: name.value, enabled });
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  sendJson(res, 200, { ok: true, operation: operationView(result.value) });
}

module.exports = {
  handlePluginMarket,
  handlePluginMarketInspect,
  handlePluginMarketInstall,
  handlePluginMarketUpdate,
  handlePluginMarketProgress,
  handlePluginMarketCancel,
  handlePluginMarketRemove,
  handlePluginMarketEnabled,
  // 纯逻辑（守卫直接加载）
  normalizeBundle,
  normalizeSpec,
  normalizeName,
  operationView,
  updateTargetOf,
  registryNameOf,
  normalizeCallError,
  SELF_NAME,
  UNAVAILABLE,
  tasks,
};
