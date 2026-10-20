'use strict';

/**
 * 手机端「插件更新」：APP 的「应用更新」页直接给这台电脑上的插件升级。
 *
 * ## 为什么手机端要有这条路
 *
 * 自动更新（外壳里那个 10 分钟轮询）有一道闸：**有对话在跑就不换文件**，等下一轮。用户在
 * 手机上聊天时，这道闸几乎永远关着，而更新入口此前只在桌面控制面（`localOnly`）—— 手机
 * 根本打不到。于是「插件有新版」这件事对手机用户等于不存在。这三条接口就是把它开给已配对
 * 的手机。
 *
 * 能力面是**有意放开**的：手机本来就握着这台宿主的凭据、能发消息，而「换掉宿主上跑的插件
 * 代码」比发消息重。所以入口只做一件事、且沿用已有的两道既有判据，不新增任何能力：
 *
 *  · **来源判据不放开**：`update-install.cjs` 的 `installAllowedFor` 只放行注册表来源
 *    （`npm`）。本地目录 / `file:` tgz / `workspace:` 装的机器（开发机就是）即便带
 *    `force` 也会被拒 —— force 只跳过「有对话在跑」和「新发布先晾一会儿」，跳不过来源。
 *  · **换代仍然就地做**：装完由外壳 `runtime.reload()` 换实现代，不重启 DSH（见 lib/index.js）。
 *
 * ## 为什么 apply 只回一句「开始了」
 *
 * 装一次要跑包管理器，几十秒到几分钟；装完换代会把**当前这一代实现连同这条路由一起卸掉**，
 * 旧代码手里的响应发不出去。所以结果不能靠这条请求的返回值，只能靠前端轮询 status。
 * 顺带一个好处：apply 期间没有在飞请求，换代时 `runtime.drain()` 不用等谁。
 *
 * 状态里给的是**身份**而不是时间戳：前端用「运行中版本变了」或「appliedAt 变了」判完成，
 * 手机与电脑的钟不一定对得上，比较时间会误判。
 *
 * ## 三条接口
 *
 *  · `GET  /api/mobile/v1/plugin/update/status` 运行中/盘上版本、安装来源、上一轮更新结果
 *  · `POST /api/mobile/v1/plugin/update/check`  问 npm 注册表有没有新版（与桌面面板同一个实现）
 *  · `POST /api/mobile/v1/plugin/update/apply`  开始一次强制更新，立即返回
 */

const path = require('node:path');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { checkForUpdate } = require('../update-registry.cjs');
const { declaredSource } = require('../update-install.cjs');
const { version: generationVersion } = require('../../package.json');

/** apply 的请求体只有 `force` 一个布尔，给 4KB 都很宽。 */
const APPLY_BODY_MAX = 4 * 1024;

/**
 * 响应写出去之后再开装。装一开始就会有人读盘，先让这一发把 202 吐完、inFlight 归零，
 * 免得换代时 drain 还要等这条请求自己。
 */
const APPLY_DEFER_MS = 150;

/**
 * 同一次安装多久算「还在跑」。装的过程中 `status.swapping` 还是 false（那时还没到换代），
 * 所以只能自己记一个开始时刻；装的上限是 10 分钟（update-install 的 INSTALL_TIMEOUT_MS），
 * 这里留两分钟余量。换代完成后这一代模块被整体丢弃，这个变量自然归零。
 */
const APPLY_BUSY_MS = 12 * 60 * 1000;

let applyingSince = 0;

/** 外壳服务；拿不到（无头部署 / 实现被直接挂载）就是没有换代能力。 */
function runtimeOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('dshMobilePluginRuntime') || null : null;
  } catch {
    return null;
  }
}

/** 上一轮更新的结果：只挑前端要用的几格，`check` 里那一坨注册表原始响应不往手机上搬。 */
function lastApplyOf(value) {
  if (!value || typeof value !== 'object') return null;
  const failure = value.failure && typeof value.failure === 'object'
    ? { code: typeof value.failure.code === 'string' ? value.failure.code : null, message: String(value.failure.message || '') }
    : null;
  return {
    installed: value.installed === true,
    skipped: value.skipped === true,
    state: typeof value.state === 'string' ? value.state : null,
    beforeVersion: typeof value.beforeVersion === 'string' ? value.beforeVersion : null,
    installedVersion: typeof value.installedVersion === 'string' ? value.installedVersion : null,
    swapped: value.swapped === true,
    retryable: value.retryable === true,
    failure,
  };
}

/**
 * 现场快照。`declaredSource` 读的是 profile 的依赖声明（同一个判据 installAllowedFor 用的
 * 就是它），所以「界面说能更新」与「真去装不会被拒」是同一件事。
 */
function snapshot(ctx) {
  const runtime = runtimeOf(ctx);
  if (!runtime) {
    return {
      supported: false,
      runningVersion: generationVersion,
      installedVersion: null,
      source: null,
      appliedAt: null,
      lastApply: null,
      shellChanged: false,
    };
  }
  const s = runtime.status();
  const profileNodeModules = typeof s.profileNodeModules === 'string' ? s.profileNodeModules : null;
  return {
    supported: typeof runtime.apply === 'function',
    runningVersion: s.version ?? null,
    installedVersion: s.installedVersion ?? null,
    // 来源读不到（profile 里没这条依赖）按「不知道」报，前端不拿它当拒绝理由 ——
    // 那种现场多半是插件压根不是从 profile 装的，装一次反而是修复。
    source: declaredSource(profileNodeModules ? path.dirname(profileNodeModules) : null) ?? s.marketResult?.source ?? null,
    appliedAt: typeof s.appliedAt === 'string' ? s.appliedAt : null,
    lastApply: lastApplyOf(s.lastApply),
    // 新版本连外壳一起改了：换得掉实现，换不掉外壳，如实报出来（那部分等下次启动）。
    shellChanged: s.shellChanged === true,
  };
}

/** `GET /plugin/update/status` */
async function handlePluginUpdateStatus(ctx, _req, res) {
  sendJson(res, 200, { ok: true, status: snapshot(ctx) });
}

/**
 * `POST /plugin/update/check`：问 npm 注册表。
 *
 * 不要求外壳在场（查不需要换代能力），盘上版本优先取外壳那份，拿不到退回这一代自己的
 * 版本号 —— 与桌面控制面 `/api/relay/update/check` 同一套口径。
 */
async function handlePluginUpdateCheck(ctx, _req, res) {
  const status = snapshot(ctx);
  try {
    const update = await checkForUpdate({
      installedVersion: status.installedVersion ?? status.runningVersion ?? generationVersion,
      source: status.source,
    });
    sendJson(res, 200, { ok: true, update, status });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: { code: 'plugin_update_check_failed', message: String(error?.message || error) },
      update: null,
      status,
    });
  }
}

/**
 * `POST /plugin/update/apply`：开始一次更新。
 *
 * 手机点的是「我现在就要更新」，所以固定带 `force`（跳过「有对话在跑」与发布晾置期）。
 * 没有可换代的外壳时回 409：盘上换了版本、运行中的实现换不掉，等于白装。
 */
async function handlePluginUpdateApply(ctx, req, res) {
  const runtime = runtimeOf(ctx);
  if (!runtime || typeof runtime.apply !== 'function') {
    return sendJson(res, 409, {
      ok: false,
      error: {
        code: 'plugin_update_unavailable',
        message: '这台宿主没有可就地换代的插件外壳，装完没法立即生效；请在电脑上更新后重启 DSH',
      },
    });
  }
  let body = {};
  try {
    body = (await readJsonBody(req, APPLY_BODY_MAX)) || {};
  } catch {
    body = {};
  }
  if (Date.now() - applyingSince < APPLY_BUSY_MS) {
    return sendJson(res, 409, {
      ok: false,
      error: { code: 'plugin_update_busy', message: '上一次更新还在进行，请等它结束' },
    });
  }
  const before = snapshot(ctx);
  const force = body.force === true;
  applyingSince = Date.now();
  sendJson(res, 200, {
    ok: true,
    started: true,
    force,
    before: { runningVersion: before.runningVersion, installedVersion: before.installedVersion, appliedAt: before.appliedAt },
  });
  setTimeout(() => {
    // 结果不在这里回给谁：它不落账、也不改 applyingSince 的成功分支 —— 换代之后这一代
    // 模块整体被丢弃，前端读的是新一代表现出来的 status。
    runtime.apply({ force }).catch(() => { applyingSince = 0; });
  }, APPLY_DEFER_MS);
}

module.exports = {
  handlePluginUpdateStatus,
  handlePluginUpdateCheck,
  handlePluginUpdateApply,
};
