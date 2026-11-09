'use strict';

/**
 * 「让 AI 操作手机」的三条普通状态路由（动作字节流在 `phone/service.js` 的升级口上）。
 *
 * - `GET  /api/mobile/v1/phone/status`：这台电脑上「操作手机」这一侧的状态 —— 服务在不在、
 *   哪几台手机连着、这条会话绑的是哪台。App 的配对向导与设置页读它。
 * - `GET  /api/mobile/v1/phone/devices`：此刻认识哪几台手机。模型改绑、用户看「另一台」时
 *   都读这份清单。
 * - `POST /api/mobile/v1/phone/unbind`：解除。带 `sessionId` 只清这条会话的绑定；不带就断开
 *   所有连接并清掉所有指向它们的绑定。
 *
 * 三条都只读状态或做收尾，**没有一条能往手机上发动作**：发动作只有 `phone/tools.js` 那条路，
 * 且只由模型在会话里触发。这个分界是刻意的 —— 路由服务的是「正在看设置页的人」，工具服务的
 * 是「正在替用户干活的模型」。
 *
 * 装配方式：路由表（`routes/mobile-api.js`）只认「路径 → handler」，所以这里给的是
 * `createPhoneRoutes(deps)` 造出来的一组 handler，`deps` 由装配层从 `phone/index.js` 转来。
 */

const { sendJson, readJsonBody } = require('../../shared/http-util');
const binding = require('./binding.js');
const pacing = require('./pacing.js');
const routeHint = require('./route-hint.js');
const knowledge = require('../phone-knowledge.js');
const access = require('./access.js');

/** 设备标题：机型优先，没有机型才用 deviceId 的短尾巴。与凭据面板同一口径。 */
function deviceLabel(row) {
  const model = row && typeof row.model === 'string' ? row.model.trim() : '';
  if (model) return row.suffix ? `${model} · ${row.suffix}` : model;
  const id = row && typeof row.deviceId === 'string' ? row.deviceId : '';
  return id ? `手机 ${id.slice(0, 8)}` : '一台没认出身份的手机';
}

/**
 * 这台电脑认识哪几台手机、哪几台此刻连着。
 *
 * 名字从凭据库拿（那里才是「这台电脑认识哪些手机」的真值），拿不到就退回 id 的短尾巴；
 * 已经连上来但凭据库里没有的（老记录、刚重置过的库）也照样报出来 —— 否则模型看不见一台
 * 明明能用的手机。
 */
function listDevices(deps) {
  const known = [];
  try {
    if (deps.credentials && deps.instanceId) {
      for (const row of deps.credentials.listDevices(deps.instanceId)) known.push(row);
    }
  } catch {
    // 凭据库读不出来不影响「谁在线」这件事：退化成只报 id。
  }
  const service = deps.getService ? deps.getService() : null;
  const online = new Map();
  if (service && service.devices) for (const [deviceId, link] of service.devices) online.set(deviceId, link);

  const rows = new Map();
  for (const row of known) {
    const live = online.get(row.deviceId);
    rows.set(row.deviceId, {
      deviceId: row.deviceId,
      name: deviceLabel(row),
      model: row.model || '',
      platform: row.platform || '',
      osVersion: row.osVersion || '',
      appVersion: row.appVersion || '',
      online: Boolean(live),
      // 能力清单只对「此刻连着」的那台有意义：设置页据此说「这台手机支持什么」。
      // 没连上时报空表，界面那边按「还没连上」处理，不拿上一次的旧清单冒充。
      capabilities: live && Array.isArray(live.capabilities) ? live.capabilities : [],
      lastSeenAt: row.lastSeenAt || 0,
    });
    if (live) online.delete(row.deviceId);
  }
  for (const [deviceId, link] of online) {
    const device = link.device || {};
    rows.set(deviceId, {
      deviceId,
      name: deviceLabel({ deviceId, model: device.model }),
      model: device.model || '',
      platform: device.platform || '',
      osVersion: device.osVersion || '',
      appVersion: device.appVersion || '',
      online: true,
      capabilities: Array.isArray(link.capabilities) ? link.capabilities : [],
      lastSeenAt: Date.now(),
    });
  }
  return [...rows.values()].sort((a, b) => (Number(b.online) - Number(a.online)) || (b.lastSeenAt - a.lastSeenAt));
}

function describeDevice(deps, deviceId) {
  const row = listDevices(deps).find((item) => item.deviceId === deviceId);
  return row ? row.name : deviceId;
}

/** GET /phone/status?sessionId=… */
async function handlePhoneStatus(deps, _ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  const service = deps.getService ? deps.getService() : null;
  const devices = listDevices(deps);
  const payload = {
    ok: true,
    running: Boolean(service),
    online: devices.filter((row) => row.online).map((row) => row.deviceId),
    devices,
  };
  if (sessionId) {
    const bound = binding.boundDeviceOf(sessionId);
    payload.binding = {
      deviceId: bound || '',
      name: bound ? describeDevice(deps, bound) : '',
      lastSender: binding.lastSenderOf(sessionId) || '',
    };
  }
  // 顶层再带一份「这台手机能做什么」：设置页问的是「我现在操作的是哪台、它能做什么」，
  // 那条会话绑了就看绑的那台，没绑就看唯第一台在线的。都没有就是空表。
  const focus = (payload.binding && payload.binding.deviceId)
    ? devices.find((row) => row.deviceId === payload.binding.deviceId)
    : devices.find((row) => row.online);
  payload.capabilities = focus && Array.isArray(focus.capabilities) ? focus.capabilities : [];
  sendJson(res, 200, payload);
}

/** GET /phone/devices */
async function handlePhoneDevices(deps, _ctx, _req, res) {
  sendJson(res, 200, { ok: true, devices: listDevices(deps) });
}

/**
 * POST /phone/unbind —— `{ sessionId?, deviceId? }`
 *
 * 不带参数是「这台电脑上操作手机这件事整个解除」：断开所有连接、清掉所有指向它们的绑定。
 * 带 `sessionId` 只清这一条会话的绑定（用户只是想让这条对话别再用那台手机）。
 *
 * 卸掉手机上那枚 adb 钥匙这一步只能由手机侧自己做（壳在手机上，宿主碰不到它），所以回包里
 * 如实写 `localReset: 'requested'`，界面据此提示「回手机上确认一下」。
 */
async function handlePhoneUnbind(deps, _ctx, req, res) {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const deviceId = body && typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (sessionId) {
    return sendJson(res, 200, {
      ok: true,
      clearedSession: binding.clearBinding(sessionId),
      disconnected: [],
      localReset: '',
    });
  }
  const service = deps.getService ? deps.getService() : null;
  const targets = deviceId ? [deviceId] : listDevices(deps).map((row) => row.deviceId);
  for (const id of targets) service?.kick?.(id);
  const cleared = targets.reduce((sum, id) => sum + binding.clearBindingForDevice(id), 0);
  sendJson(res, 200, { ok: true, clearedSession: false, clearedBindings: cleared, disconnected: targets, localReset: 'requested' });
}

/**
 * GET /phone/knowledge?package=… —— 知识库里有哪些 App、有哪些网站，各自包名 / 域名，以及按就
 * 包名查询时的命中情况。
 *
 * 只读：把 `knowledge/apps/*.md` 与 `knowledge/sites/*.md` 的目录清单摊平给设置页看，不碰手机、
 * 不发任何动作。`package` 是可选的前台包名；给了就标出哪一条 App 命中（`hit`），并回填 `matched`。
 */
async function handlePhoneKnowledge(deps, _ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const pkg = (url.searchParams.get('package') || '').trim();
  const matched = pkg ? knowledge.matchApp(pkg) : null;
  const apps = knowledge.listApps().map((app) => ({
    name: app.name,
    display: app.display,
    packages: app.packages,
    aliases: app.aliases,
    open: app.open,
    hit: Boolean(matched && matched.name === app.name),
  }));
  const sites = knowledge.listSites().map((site) => ({
    name: site.name,
    display: site.display,
    description: site.description,
    sites: site.domains,
    aliases: site.aliases,
  }));
  sendJson(res, 200, { ok: true, apps, sites, matched: matched ? matched.name : '' });
}

/**
 * GET /phone/routes?package=… —— 某个 App 以前成功过的路线（最多 5 条，只给步骤摘要）。
 *
 * 只读：从成功路线账本里读回，不碰手机、不发任何动作。**这些只是参考，不会自动执行** ——
 * 模型看过之后仍要按当前屏重新判断。
 */
async function handlePhoneRoutes(_deps, _ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const pkg = (url.searchParams.get('package') || '').trim();
  const routes = pkg ? routeHint.hintFor(pkg) : [];
  sendJson(res, 200, { ok: true, packageName: pkg, count: routes.length, routes });
}

/**
 * GET / POST /phone/pacing —— 读或改「操作节奏」那一档。
 *
 * 和上面几条一样只碰设置，不往手机上发动作：节奏改了下一轮动作才生效，正在跑的那一批
 * 不跟着变（动作中途改停留会让边界很奇怪，重开一轮才干净）。
 */
async function handlePhonePacing(_deps, _ctx, req, res) {
  if (req.method === 'GET' || !req.method) {
    const mode = pacing.get();
    return sendJson(res, 200, { ok: true, mode, pace: pacing.paceFor(mode) });
  }
  const body = await readJsonBody(req);
  const wanted = body && typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
  if (!wanted) return sendJson(res, 400, { ok: false, error: 'missing-mode' });
  try {
    const mode = pacing.set(wanted);
    sendJson(res, 200, { ok: true, mode, pace: pacing.paceFor(mode) });
  } catch {
    // 不认识的档名：如实回 400 并把可选值带上，别让设置页自己维护一份枚举。
    sendJson(res, 400, { ok: false, error: 'unknown-mode', modes: pacing.MODES });
  }
}

/**
 * 组装 `/phone/app-access` 要回的 App 清单：**已配置项 ∪ 宿主 App 知识库里认识的 App**。
 *
 * 只读宿主侧存储（`access` 的落盘 + `knowledge/apps/*.md`），不向手机发任何动作。已配置的
 * 带 `configured:true`；只有知识库认识、用户还没动过开关的带 `configured:false`、档走默认
 * （`modeFor` 的 ask），这样设置页一打开就能列出「能管的 App」而不是一张空表。
 *
 * 知识库取不到或形状不对（目录没了、文件写坏、以后改了字段名）就**退回只回已配置项**：
 * 少列几个 App 是界面难看，抛出去就是设置页打不开。排序交给 App，这边不排。
 *
 * @returns {Array<{packageName:string, appName:string, mode:string, shareAllowed:boolean, configured:boolean}>}
 */
function appAccessRows() {
  const state = access.readState();
  const rows = [];
  const seen = new Set();
  const push = (pkg, appName, configured) => {
    const name = typeof pkg === 'string' ? pkg.trim() : '';
    if (!name || seen.has(name)) return;
    seen.add(name);
    const label = typeof appName === 'string' && appName.trim() ? appName.trim() : name;
    rows.push({
      packageName: name,
      appName: label,
      mode: access.modeFor(state, name),
      shareAllowed: Array.isArray(state.shareAllowed) && state.shareAllowed.includes(name),
      configured,
    });
  };

  let known = [];
  try {
    known = knowledge.listApps();
  } catch {
    known = [];
  }
  if (!Array.isArray(known)) known = [];

  // 先摆已配置的（顺序跟落盘一致），再补知识库里还没配置过的。
  for (const row of access.rows()) push(row.packageName, '', true);
  for (const app of known) {
    if (!app || typeof app !== 'object' || !Array.isArray(app.packages)) continue;
    for (const pkg of app.packages) push(pkg, app.display || app.name, false);
  }
  return rows;
}

/**
 * 逐 App 访问控制（三档）：GET 读全部开关行，POST 改一个 App 的档 / 分享例外。
 *
 * 只是本地开关，不往手机上发动作；名单落 `$DSH_HOME/storages/mobile-plugin/phone-app-access.json`，
 * 宿主 `tools.js` 执行前按同一份名单 gate。包名形状在这里先校验，挡住把路径/命令塞进来。
 * GET/POST 成功都回同一份形状（`defaultMode` + `apps`），界面读一次就能显示「其余默认」。
 */
async function handlePhoneAppAccess(_deps, _ctx, req, res) {
  const payload = () => ({ ok: true, defaultMode: access.DEFAULT_MODE, apps: appAccessRows() });
  if (req.method === 'GET' || !req.method) {
    return sendJson(res, 200, payload());
  }
  const body = await readJsonBody(req);
  const packageName = body && typeof body.packageName === 'string' ? body.packageName : '';
  const hasMode = Boolean(body) && body.mode !== undefined;
  const hasShare = Boolean(body) && typeof body.shareAllowed === 'boolean';
  if (!hasMode && !hasShare) {
    return sendJson(res, 400, { ok: false, error: 'missing-flags' });
  }
  const patch = {};
  if (hasMode) patch.mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : body.mode;
  if (hasShare) patch.shareAllowed = body.shareAllowed;
  const result = access.update(packageName, patch);
  if (!result.ok) {
    if (result.error === 'unknown-mode') {
      return sendJson(res, 400, { ok: false, error: 'unknown-mode', modes: result.modes || access.MODES });
    }
    return sendJson(res, 400, { ok: false, error: result.error });
  }
  sendJson(res, 200, payload());
}

/**
 * 造出路由表要的那组 handler。
 *
 * @param {object} deps
 * @param {() => object|null} deps.getService 取值器（服务随插件重载整体替换）
 * @param {object} [deps.credentials] 凭据库
 * @param {string} [deps.instanceId]
 */
function createPhoneRoutes(deps) {
  return {
    status: (ctx, req, res) => handlePhoneStatus(deps, ctx, req, res),
    devices: (ctx, req, res) => handlePhoneDevices(deps, ctx, req, res),
    unbind: (ctx, req, res) => handlePhoneUnbind(deps, ctx, req, res),
    knowledge: (ctx, req, res) => handlePhoneKnowledge(deps, ctx, req, res),
    routes: (ctx, req, res) => handlePhoneRoutes(deps, ctx, req, res),
    pacing: (ctx, req, res) => handlePhonePacing(deps, ctx, req, res),
    appAccess: (ctx, req, res) => handlePhoneAppAccess(deps, ctx, req, res),
  };
}

module.exports = {
  createPhoneRoutes,
  handlePhoneStatus,
  handlePhoneDevices,
  handlePhoneUnbind,
  handlePhoneKnowledge,
  handlePhoneRoutes,
  handlePhonePacing,
  handlePhoneAppAccess,
  appAccessRows,
  listDevices,
  describeDevice,
  deviceLabel,
};
