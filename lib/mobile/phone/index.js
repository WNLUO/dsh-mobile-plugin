'use strict';

/**
 * 「让 AI 操作手机」这一整块的装配入口。
 *
 * 一条调用做三件事：建常驻连接、把模型那组动作工具注册上、在插件卸载时收掉连接。
 *
 * **路由不在这里挂**：三条普通路由与那条升级口写进了 `routes/mobile-api.js` 那张表 ——
 * 那张表的唯一用途就是「一眼确认 App 打的地址到底注册没有」，`test/mobile-routes.test.cjs`
 * 拿 App 的 `apiPaths.ts` 反向核对它。挂在这边等于绕开那道对账，App 侧一改名就静默 404。
 *
 * 服务必须**每个插件实例一份**：连接跟着插件走，热替换之后旧实例没人关就会漏一条手机连接。
 * 所以建与关成对出现，关挂在 `ctx.effect` 上。
 */

const { createPhoneService } = require('./service.js');
const permissions = require('../permissions.js');
const { presentedCredential } = require('../auth.js');
const { installPhoneTools } = require('./tools.js');
const { installRouteHint } = require('./route-hint.js');
const { installSkillRecall, installSkillKeep } = require('./skill-recall.js');
const { listDevices, describeDevice } = require('./routes.js');
const binding = require('./binding.js');
const pacing = require('./pacing.js');
const irreversible = require('./irreversible.js');
const routesMemory = require('./routes-memory.js');

/**
 * @param {object} ctx 插件上下文
 * @param {object} deps
 * @param {(req: object) => boolean} deps.authorized 现有那条鉴权判定
 * @param {object} [deps.credentials] 凭据库（报设备名要用它的 `listDevices`）
 * @param {string} [deps.instanceId]
 * @param {string} [deps.name] 插件名（日志前缀）
 * @param {object} [deps.permission] 升级路由的权限位判定（升级路由不过 guarded，见 service.js）；
 *   不传就按 `credentials` + `instanceId` 现建一份 —— 动作通道必须按权限位拦，不能靠调用方记得传
 * @returns {object} 这一实例的手机操作服务（装配层转手交给路由表）
 */
function mountPhoneControl(ctx, deps) {
  const log = (message) => ctx.logger?.info?.(`${deps.name || 'dsh-mobile-plugin'}: %s`, message);
  // 动作通道是 **WebSocket 升级**路由，不过 `guarded`：只验凭据不验 `operate` 会让只读档设备
  // 直接摸到「让 AI 操作手机」的面。判定与 guarded 是同一套（`permissions.js` 里那两条升级
  // 路由也登了记），这里只把需要的三件传进去。
  const permission = deps.permission || permissions.createUpgradePermission({
    credentials: deps.credentials,
    instanceId: deps.instanceId,
    presentedCredential,
  });
  const service = createPhoneService({ authorized: deps.authorized, onLog: log, permission });
  const routeDeps = {
    getService: () => service,
    credentials: deps.credentials,
    instanceId: deps.instanceId,
  };

  // 工具：缺 tools 注入的 profile 只少这一组，别把整块装配掀掉（与 extensions / cleanup 同口径）。
  try {
    installPhoneTools(ctx, {
      getService: () => service,
      listDevices: () => listDevices(routeDeps).map((row) => ({
        deviceId: row.deviceId,
        name: row.name,
        online: row.online,
      })),
      describeDevice: (deviceId) => describeDevice(routeDeps, deviceId),
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }

  // 只读的历史路线查询工具：单独一路注册，不经过 tools.js 那套步数/死循环守卫（它不发动作）。
  // 同一口径：缺 tools 注入的 profile 只少这一条，不要把整块装配掀掉。
  try {
    installRouteHint(ctx);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }

  // 学成的路线查询：与上面同一条路（只读、不发动作），查的是技能目录里收下的路线，
  // 给的是能直接落成 phone_* 调用的步骤目标。重放仍由模型逐条驱动原来那些动作。
  try {
    installSkillRecall(ctx);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }

  // 收下 / 丢掉学成的路线：学完一律是草稿，要人点一下才生效 —— 这一条就是那个「点一下」，
  // 同样不发动作。
  try {
    installSkillKeep(ctx);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.includes('without inject')) throw error;
  }

  ctx.effect(() => () => service.close(), `${deps.name || 'dsh-mobile-plugin'}: phone control`);
  // 路由表那边要凭据库与实例号来报设备名，而它只拿得到这个服务（装配层只转交一个对象）。
  // 挂在服务上而不是再走一遍依赖注入：多一处注入就多一处能不同步的地方。
  service.credentials = deps.credentials;
  service.instanceId = deps.instanceId;
  // 节奏与不可逆判定是纯函数模块，挂到服务上，工具层拿同一个服务就能顺手取到，
  // 省得再开一路依赖注入 —— 少一处注入就少一处能不同步的地方。
  service.pacing = pacing;
  service.irreversible = irreversible;
  // 成功路线记忆：工具层在结局判定为成功后调 `service.routesMemory.record(...)`，查询走
  // `phone_route_hint`。挂到服务上，与 pacing / irreversible 同一口径，少一路依赖注入。
  service.routesMemory = routesMemory;
  return service;
}

module.exports = { mountPhoneControl, binding, pacing, irreversible, routesMemory };
