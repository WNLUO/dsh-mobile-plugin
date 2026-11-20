// 对齐 Plugin Manager v2：安全更新、版本列表与失败恢复状态经移动端透传。
'use strict';

/**
 * 移动端「插件管理」：这台电脑上 DSH 装了哪些插件、装 / 启用 / 升级。
 *
 * 不自己跑包管理器：DSH 宿主里本来就有一套插件管理器（`pluginManager` 服务，桌面端
 * 设置 → 插件 那个页面就是它的界面），装包、版本兼容检查、依赖脚本授权、装失败回滚、
 * 「要不要重启才生效」全由它判断。这里只做三件事：把它的结果削成手机要的形状、把手机
 * 发来的动作转过去、把一次安装的进度留在内存里给轮询。
 *
 * 失败原因：宿主的错误对象可能把原文放在 `diagnostic`，也可能放在 `message`；两种都原样
 * 带回给 App，别在投影里丢掉 —— 手机要能看到「为什么没装成」。
 *
 * 能力面收在三条上（与桌面端同一个判据，不另开）：
 *  1. **只经 typertGateway 走 `pluginManager`**，不走 shell、不碰系统设置；
 *  2. **卸载只对「宿主说它可卸」的包开放**：`/plugin/market/remove` 转 `removeBundle`，但
 *     承载本 App 连接的那个包（dsh-mobile-plugin）与 DSH 自带 / 按需安装的官方包一律不给
 *     （它们要么把这台手机变成砖，要么本来就不可卸）；界面先问 `removable`，按钮摆不摆由它定。
 *     卸完要等电脑上下次启动 DSH 才真的不在，这条代价写在界面确认框里；
 *  3. 安装/启用**不改 DSH 的启动方式**：新装的插件要不要重启才生效由宿主自己回报，界面照实说。
 *
 * 接口（都挂 `/api/mobile/v1/plugin/market`，走 token 守卫）：
 *  GET  `/plugin/market`            → { bundles }
 *  GET  `/plugin/market/registries` → { registry, fallbackRegistries, resolved }：安装时能选的 npm 源
 *  GET  `/plugin/market/versions?name=&registry=` → 宿主版本列表与兼容性结果
 *  POST `/plugin/market/inspect`    { spec } → 读一下这个包是什么
 *  GET  `/plugin/market/detail?name=&language=` → { status, markdown, origin }：插件说明文档
 *  POST `/plugin/market/remove`     { name, requestId? } → 卸载（立即返回，结果看 progress）
 *  POST `/plugin/market/install`    { spec, registry?, requestId?, approvedBuilds? } → 开始装（立即返回）
 *  POST `/plugin/market/update`     { name, version, registry?, spec?, requestId? } → 宿主安全更新
 *  POST `/plugin/market/cancel`     { requestId } → 停一次正在跑的安装
 *  GET  `/plugin/market/progress?requestId=` → 那一次装完没有
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

/** 承载 App 连接的那个包：只可更新，不可停用（卸载没有入口）。 */
const SELF_NAME = pkg.name;

const SPEC_MAX_CHARS = 300;
const NAME_MAX_CHARS = 300;
const REQUEST_ID_MAX_CHARS = 120;
const BUNDLES_MAX_ITEMS = 300;
/** npm 源是一个 URL，与 spec 同一个量级；备用源按顺序全报，20 条封顶。 */
const REGISTRY_MAX_CHARS = 300;
const REGISTRIES_MAX_ITEMS = 20;
/** 插件图标是一张内联 data URL；按 40KB 封顶（正常一张 16~48px 的图远小于这个）。 */
const ICON_MAX_CHARS = 40 * 1024;
/** 说明文档可能很长，但手机只画一段：64KB 封顶，超出截断并保留「已截断」语义。 */
const DETAIL_MAX_CHARS = 64 * 1024;
/** 内存里最多留几条安装记录：手机只会盯手上这一条，多的是断线前留下的。 */
const TASKS_MAX = 20;
const BODY_MAX_BYTES = 8 * 1024;

/** 安装结果里对手机有意义的几格（宿主的 `application` / `stage` / `error` 原样透出）。 */
const APPLICATIONS = new Set(['cancelled', 'failed', 'applied', 'restart-required', 'overridden', 'unknown']);
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
/** 宿主一次失败里带的原因原文：优先用 `diagnostic`，没有再退回 `message`（两处都可能承载）。 */
function errorDetailOf(error) {
  if (!error || typeof error !== 'object') return '';
  if (typeof error.diagnostic === 'string' && error.diagnostic) return error.diagnostic;
  if (typeof error.message === 'string' && error.message) return error.message;
  return '';
}

function operationView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = value.error && typeof value.error === 'object'
    ? { code: textOrNull(value.error.code, 64) || 'operation-error', message: errorDetailOf(value.error),
      ...(Array.isArray(value.error.incompatible) ? { incompatible: value.error.incompatible.slice(0, 20).map(incompatibleView).filter(Boolean) } : {}),
    } : null;
  return {
    changed: value.changed === true,
    application: APPLICATIONS.has(value.application) ? value.application : 'unknown',
    restartReason: RESTART_REASONS.has(value.restartReason) ? value.restartReason : null,
    stage: textOrNull(value.stage, 16),
    target: textOrNull(value.target, NAME_MAX_CHARS),
    version: textOrNull(value.version, 64),
    pendingBuilds: Array.isArray(value.pendingBuilds)
      ? value.pendingBuilds.filter((name) => typeof name === 'string').slice(0, 20) : [],
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings.filter((item) => typeof item === 'string').slice(0, 20) } : {}),
    ...(value.failedAt === 'registry' || value.failedAt === 'spec-host' ? { failedAt: value.failedAt } : {}),
    error,
  };
}

function incompatibleView(value) {
  if (!value || typeof value !== 'object') return null;
  const name = textOrNull(value.name, NAME_MAX_CHARS);
  const version = textOrNull(value.version, 64);
  const runtimeVersion = textOrNull(value.runtimeVersion, 64);
  if (!name || !version || !runtimeVersion) return null;
  const requirements = {};
  for (const [key, requirement] of Object.entries(value.requirements || {}).slice(0, 30)) {
    if (typeof requirement === 'string') requirements[key] = requirement.slice(0, 300);
  }
  return { name, version, runtimeVersion, requirements };
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
      message: errorDetailOf(row.error),
    }
    : null;
  // icon 是宿主给的**图片 data URL**（包根 manifest 的 icon，或 `<specifier>/icon` 导出），
  // 原样转给 App 当图片画；不要拼进文案、也不是 SVG 标记。只有部分插件有。
  const icon = meta && typeof meta.icon === 'string' && /^data:image\//.test(meta.icon)
    ? meta.icon.slice(0, ICON_MAX_CHARS)
    : null;
  return {
    name,
    version: textOrNull(row.version, 64),
    icon,
    title: meta ? displayField(meta.title) : null,
    description: (meta ? displayField(meta.description) : null) || textOrNull(row.description, 400),
    source: textOrNull(row.source, SPEC_MAX_CHARS),
    enabled: row.enabled === true,
    installed: row.installed === true,
    official: row.official === true,
    optional: row.optional === true,
    removable: row.removable === true,
    update: row.update === 'registry' || row.update === 'git' ? row.update : row.updatable === true ? 'registry' : null,
    safeUpdate: name !== SELF_NAME && (row.update === 'registry' || row.update === 'git' || row.updatable === true),
    availability: textOrNull(row.availability, 16),
    installTarget: installTarget && installTarget.spec ? installTarget : null,
    /** 承载 App 连接的自己：停用一律拒绝、卸载没有入口，只留更新（见文件头）。 */
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
 * 安装时指定的 npm 源。**空着与给空串都不是一件事**：宿主那边「不传 registry」= 跟随它
 * 自己配置的那个源，所以没给就一个键都不留；给了就必须是一段像样的 URL 文本。
 */
function normalizeRegistry(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { problem: 'registry 必须是一个字符串' };
  const text = value.trim();
  if (!text) return { value: null };
  if (text.length > REGISTRY_MAX_CHARS) return { problem: `registry 太长（上限 ${REGISTRY_MAX_CHARS} 个字符）` };
  return { value: text };
}

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

function updateTargetOf(bundle, version, options = {}) {
  if (!bundle) return { problem: '这台宿主上没有这个插件' };
  if (bundle.name === SELF_NAME) return { problem: '这个插件要在「版本与更新」那一块更新（那条会自检、失败会自己退回）' };
  if (bundle.update === 'git') {
    const spec = normalizeSpec(options.spec);
    if (!spec.value) return { problem: 'Git 插件更新必须提供固定提交 spec' };
    return { spec: spec.value, registry: null };
  }
  if (bundle.update !== 'registry' && bundle.updatable !== true) return { problem: '这个插件没有宿主提供的安全更新能力' };
  const targetVersion = textOrNull(version, 64);
  if (!targetVersion) return { problem: '更新必须指定目标版本' };
  return { version: targetVersion, registry: normalizeRegistry(options.registry).value };
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
 * GET /api/mobile/v1/plugin/market/registries
 * 安装时能选的 npm 源：配置里的第一个源（`registry`，null = 用 pnpm 自己配置的那个）、
 * 备用源（`fallbackRegistries`，按顺序）、以及 pnpm 实际读到的那个 URL（`resolved`）。
 * 手机拿它做一个选择器，选中的值原样回到 `/install` 的 `registry`。
 */
async function handlePluginMarketRegistries(ctx, _req, res) {
  const result = await call(ctx, 'registries', {});
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const fallbackRegistries = [];
  const raw = Array.isArray(value.fallbackRegistries) ? value.fallbackRegistries : [];
  for (const item of raw) {
    const text = textOrNull(item, REGISTRY_MAX_CHARS);
    if (!text) continue;
    fallbackRegistries.push(text);
    if (fallbackRegistries.length >= REGISTRIES_MAX_ITEMS) break;
  }
  sendJson(res, 200, {
    ok: true,
    registry: textOrNull(value.registry, REGISTRY_MAX_CHARS),
    fallbackRegistries,
    resolved: textOrNull(value.resolved, REGISTRY_MAX_CHARS),
  });
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
 * POST /api/mobile/v1/plugin/market/install  { spec, registry?, requestId?, approvedBuilds? }
 * 立即返回 `{ ok:true, requestId }`；装没装完由 `/progress` 问。装一次可能几十秒到几分钟，
 * 手机上不该挂一条长请求等它。
 */
async function handlePluginMarketInstall(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const spec = normalizeSpec(body && body.spec);
  if (!spec.value) return badRequest(res, spec.problem);
  const registry = normalizeRegistry(body && body.registry);
  if (registry.problem) return badRequest(res, registry.problem);
  const approvedBuilds = Array.isArray(body && body.approvedBuilds)
    ? body.approvedBuilds.filter((name) => typeof name === 'string' && name.trim()).slice(0, 40)
    : [];
  const requestId = readRequestId(body && body.requestId, () => localRequestId('install'));
  beginTask(requestId, 'install', spec.value);
  // 不在请求里等：宿主的 installBundle 是长任务，手机断线/切后台不该把它拖断。
  void (async () => {
    const options = { requestId, enabled: true };
    if (approvedBuilds.length) options.approvedBuilds = approvedBuilds;
    if (registry.value) options.registry = registry.value;
    const result = await call(ctx, 'installBundle', { spec: spec.value, options });
    finishTask(requestId, result.error
      ? { ok: false, error: result.error }
      : { ok: true, operation: operationView(result.value), spec: spec.value });
  })();
  sendJson(res, 202, { ok: true, requestId });
}

/** GET /plugin/market/versions?name=&registry=：只问宿主，不自行查询注册表。 */
async function handlePluginMarketVersions(ctx, req, res) {
  const params = new URL(req.url || '/', 'http://x').searchParams;
  const name = normalizeName(params.get('name'));
  if (!name.value) return badRequest(res, name.problem);
  const registry = normalizeRegistry(params.get('registry'));
  if (registry.problem) return badRequest(res, registry.problem);
  const result = await call(ctx, 'listVersions', { name: name.value, ...(registry.value ? { options: { registry: registry.value } } : {}) });
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const attempts = (Array.isArray(value.attempts) ? value.attempts : []).slice(0, 20).map((item) => ({
    registry: textOrNull(item?.registry, REGISTRY_MAX_CHARS),
    ...(textOrNull(item?.problem, 32) ? { problem: textOrNull(item.problem, 32) } : {}),
    ...(typeof item?.reason === 'string' ? { reason: item.reason.slice(0, 4000) } : {}),
  }));
  if (value.status !== 'listed') return sendJson(res, 200, { ok: true, name: name.value, status: 'refused',
    problem: textOrNull(value.problem, 32) || 'unknown', reason: typeof value.reason === 'string' ? value.reason : '', attempts });
  const versions = (Array.isArray(value.versions) ? value.versions : []).slice(0, 100).filter((item) => textOrNull(item?.version, 64)).map((item) => ({
    version: textOrNull(item.version, 64), tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [],
    prerelease: item.prerelease === true, bundle: item.bundle === true,
    ...(textOrNull(item.publishedAt, 64) ? { publishedAt: textOrNull(item.publishedAt, 64) } : {}),
    ...(typeof item.deprecated === 'string' ? { deprecated: item.deprecated.slice(0, 4000) } : {}),
    ...(incompatibleView(item.incompatible) ? { incompatible: incompatibleView(item.incompatible) } : {}),
  }));
  sendJson(res, 200, { ok: true, name: name.value, status: 'listed', installed: textOrNull(value.installed, 64),
    registry: textOrNull(value.registry, REGISTRY_MAX_CHARS), attempts, versions,
    omitted: Number.isSafeInteger(value.omitted) && value.omitted >= 0 ? value.omitted : 0 });
}

/** POST /plugin/market/update {name,version,registry?,spec?,requestId?}：替换和恢复均由宿主负责。 */
async function handlePluginMarketUpdate(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const name = normalizeName(body && body.name);
  if (!name.value) return badRequest(res, name.problem);
  const version = textOrNull(body && body.version, 64);
  if (!version) return badRequest(res, '更新必须指定目标版本');
  const registry = normalizeRegistry(body && body.registry);
  if (registry.problem) return badRequest(res, registry.problem);
  const listed = await call(ctx, 'listBundles', {});
  if (listed.error) return sendJson(res, statusOf(listed.error), { ok: false, error: listed.error });
  const bundle = Array.isArray(listed.value) ? listed.value.map(normalizeBundle).find((item) => item && item.name === name.value) : null;
  const target = updateTargetOf(bundle, version, body || {});
  if (target.problem) return sendJson(res, 400, { ok: false, error: { code: 'no-update-target', message: target.problem } });
  if (bundle.update !== 'git' && body.spec !== undefined) return badRequest(res, '注册表插件更新不接受 spec');
  const requestId = readRequestId(body && body.requestId, () => localRequestId('update'));
  if (tasks.has(requestId)) return sendJson(res, 202, { ok: true, requestId, name: name.value, version });
  const task = beginTask(requestId, 'update', name.value);
  task.phase = 'checking';
  let dispose;
  if (typeof ctx?.on === 'function') dispose = ctx.on('plugin-manager/update-state', (progress) => {
    if (progress?.requestId === requestId && ['checking', 'removing', 'installing', 'restoring'].includes(progress.step)) task.phase = progress.step;
  }, { global: true });
  void (async () => {
    try {
      const options = { requestId, ...(registry.value ? { registry: registry.value } : {}), ...(target.spec ? { spec: target.spec } : {}) };
      const updated = await call(ctx, 'updateBundle', { name: name.value, version, options });
      if (updated.error) return finishTask(requestId, { ok: false, error: updated.error, stage: task.phase, unknown: updated.error.code !== UNAVAILABLE.code });
      const value = updated.value && typeof updated.value === 'object' ? updated.value : {};
      const operation = operationView(value.result);
      const restore = operationView(value.restore);
      finishTask(requestId, { ok: true, operation: operation || { application: 'unknown' }, stage: textOrNull(value.step, 16),
        update: { from: textOrNull(value.from, 64), to: textOrNull(value.to, 64), step: textOrNull(value.step, 16), ...(restore ? { restore } : {}) } });
    } catch (error) { finishTask(requestId, { ok: false, unknown: true, error: normalizeCallError(error) }); }
    finally { if (typeof dispose === 'function') dispose(); }
  })();
  sendJson(res, 202, { ok: true, requestId, name: name.value, version });
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
  if (task.state === 'running') return sendJson(res, 200, { ok: true, state: 'running', kind: task.kind, ...(task.phase ? { phase: task.phase } : {}) });
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

/**
 * GET /api/mobile/v1/plugin/market/detail?name=&language=
 *
 * 一个插件的说明文档：宿主先找它 `meta.detail` 指着的那份本地化文档、找不到退回包里的
 * README；已装的从包目录读（不联网），没装的官方按需插件从 npm 文件 CDN 读。**原文就是
 * Markdown**，手机自己渲染 —— 别在插件侧把它转成 HTML，那会把链接、代码块与图片一起做坏。
 *
 * `status: 'none'` 表示这个包没有文档，不是错。
 */
async function handlePluginMarketDetail(ctx, req, res) {
  const params = new URL(req.url || '/', 'http://x').searchParams;
  const name = normalizeName(params.get('name'));
  if (!name.value) return badRequest(res, name.problem);
  const language = textOrNull(params.get('language'), 16)
    || textOrNull(req.headers && req.headers['accept-language'], 16)
    || 'en';
  const result = await call(ctx, 'readBundleDetail', { name: name.value, language });
  if (result.error) return sendJson(res, statusOf(result.error), { ok: false, error: result.error });
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  if (value.status !== 'found') {
    return sendJson(res, 200, { ok: true, status: 'none', name: name.value });
  }
  const markdown = typeof value.markdown === 'string' ? value.markdown : '';
  sendJson(res, 200, {
    ok: true,
    status: 'found',
    name: name.value,
    // `locale` 是包里那份本地化文档，`readme` 是 README；界面不用它，留着排查用。
    origin: textOrNull(value.origin, 16),
    path: textOrNull(value.path, 300),
    // 太长就截断：手机只画一段说明，64KB 已经远超一屏能读的量。
    markdown: markdown.length > DETAIL_MAX_CHARS
      ? `${markdown.slice(0, DETAIL_MAX_CHARS)}\n\n…`
      : markdown,
  });
}

/**
 * POST /api/mobile/v1/plugin/market/remove  { name, requestId? }
 *
 * 卸载一个插件：转给宿主的 `removeBundle`（它拿到 pnpm 那条路去删依赖、卸层），与桌面
 * 设置 → 插件里那颗「卸载」是同一条实现。**立即返回 202 + requestId**，结果看 progress。
 *
 * 三道闸：承载手机连接的那个包一律拒（卸了这台手机就再也连不上）、没装上的行拒、
 * 宿主说 `removable:false` 的（自带 / 安装提供的官方包）拒。判据都以宿主清单为准，
 * 不在这里另立一份白名单。
 */
async function handlePluginMarketRemove(ctx, req, res) {
  const body = await readJsonBody(req, BODY_MAX_BYTES);
  const name = normalizeName(body && body.name);
  if (!name.value) return badRequest(res, name.problem);
  if (name.value === SELF_NAME) {
    return sendJson(res, 403, {
      ok: false,
      error: {
        code: 'self-protected',
        message: '卸掉这个插件等于断开这台手机；要卸载请到电脑上的 DSH 里操作',
      },
    });
  }
  const listed = await call(ctx, 'listBundles', {});
  if (listed.error) return sendJson(res, statusOf(listed.error), { ok: false, error: listed.error });
  const bundle = Array.isArray(listed.value)
    ? listed.value.map(normalizeBundle).find((item) => item && item.name === name.value)
    : null;
  if (!bundle) {
    return sendJson(res, 404, { ok: false, error: { code: 'unknown-plugin', message: '这台宿主上没有这个插件' } });
  }
  if (bundle.removable !== true) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'not-removable', message: '这个插件是 DSH 自带或安装提供的，不能在手机上卸载' },
    });
  }
  const requestId = readRequestId(body && body.requestId, () => localRequestId('remove'));
  beginTask(requestId, 'remove', name.value);
  void (async () => {
    const removed = await call(ctx, 'removeBundle', { name: name.value });
    finishTask(requestId, removed.error
      ? { ok: false, error: removed.error }
      : { ok: true, operation: operationView(removed.value), spec: name.value });
  })();
  sendJson(res, 202, { ok: true, requestId });
}

module.exports = {
  handlePluginMarket,
  handlePluginMarketRegistries,
  handlePluginMarketVersions,
  handlePluginMarketDetail,
  handlePluginMarketRemove,
  handlePluginMarketInspect,
  handlePluginMarketInstall,
  handlePluginMarketUpdate,
  handlePluginMarketProgress,
  handlePluginMarketCancel,
  handlePluginMarketEnabled,
  // 纯逻辑（守卫直接加载）
  normalizeBundle,
  normalizeSpec,
  normalizeName,
  normalizeRegistry,
  operationView,
  updateTargetOf,
  registryNameOf,
  normalizeCallError,
  SELF_NAME,
  UNAVAILABLE,
  tasks,
};
