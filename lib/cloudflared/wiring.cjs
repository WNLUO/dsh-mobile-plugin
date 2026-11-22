// Cloudflare 兜底隧道接线：runner 创建、地址回报（存/还原 previous-direct）、自动启动与启停包装。
'use strict';

/**
 * 把 Cloudflare 兜底隧道挂进装配层：本地拉起 cloudflared 快速隧道，把拿到的 https 地址
 * 写进直连格（`manualLanUrl`），关闭时还原用户原本手填的直连地址。
 *
 * 单独一个文件是因为装配层有行数上限（`test/assembly-layer.test.cjs` 钉着）——那些上限是
 * 「实现不许搬回装配层」。进程生命周期、banner 解析在 `runner.cjs`，二进制获取在
 * `provision.cjs`，这里只做挂载与那几处装配动作。
 *
 * 写的是 `manualLanUrl`（直连格），**绝不**写 `manualTcpUrl`（那是 frp 的 TCP 格）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('../shared/paths.js');
const { createCloudflaredRunner } = require('./runner.cjs');

/**
 * @param {object} options
 * @param {(label: string, fn: Function) => any} options.mount 装配层的兜底挂载
 * @param {(message: string, ...rest: any[]) => void} options.warn 告警出口
 * @param {object} options.state relay.json 那份内存状态（唯一真值）
 * @param {{ update: (patch: object) => Promise<any> }} options.settings 配置仓（写盘并触发 applyServices）
 * @param {() => number} options.portOf 本机实绑端口（会漂）
 * @param {object} options.ctx 插件 ctx（只为 `ctx.effect` 与 `ctx.get`）
 * @param {string} options.name 插件名，用于 effect 标签
 * @returns {{ start: Function, stop: Function, status: Function, syncLocalPort: Function }}
 */
function mountCloudflare(options) {
  const { mount, warn, state, settings, portOf, ctx, name } = options;
  // 外壳持有 runner 时沿用（换代不重启隧道）；缺省走本地。
  let host = null;
  try { host = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportCloudflare') || null : null } catch { host = null; }
  const runner = host && host.runner ? host.runner : createCloudflaredRunner({ portOf });
  // 「用户原本手填的直连地址」落盘在 runner 的数据目录：开启覆盖前存一次，停用后读回。
  // 只在该文件不存在时写，避免之后地址变化时把上一次的隧道地址当成原值。
  const dataDir = (runner && runner._paths && runner._paths.dir) || path.join(dshHome(), 'cloudflare-run');
  const previousDirectFile = path.join(dataDir, 'previous-direct.txt');
  const rememberPreviousDirect = () => {
    try {
      if (fs.existsSync(previousDirectFile)) return;
      const current = typeof state.manualLanUrl === 'string' ? state.manualLanUrl : '';
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(previousDirectFile, current);
    } catch (error) { warn('记录原直连地址失败：%s', error?.message || error); }
  };
  const readPreviousDirect = () => {
    try { return fs.readFileSync(previousDirectFile, 'utf8'); } catch { return null; }
  };
  const clearPreviousDirect = () => { try { fs.rmSync(previousDirectFile, { force: true }); } catch { /* 已不存在。 */ } };

  // 控制面开关：start 幂等（runner 自己写 enabled 标记）；stop 幂等（runner 删标记后恢复原地址）。
  const start = async () => { await runner.start(); return runner.status(); };
  const stop = async () => {
    await runner.stop();
    const previous = readPreviousDirect();
    if (previous !== null) {
      await settings.update({ manualLanUrl: previous });
      clearPreviousDirect();
    }
    return runner.status();
  };
  const status = () => runner.status();
  const syncLocalPort = () => (typeof runner.syncLocalPort === 'function' ? runner.syncLocalPort() : Promise.resolve(runner.status()));

  // 地址回报：隧道拿到新 https 地址时写进直连格。写之前先存一份原地址，停用后原地还原。
  // settings.update 会经 settings.watch → applyServices → control.sync() 自动把新地址报给总控。
  mount('cloudflare 地址', () => ctx.effect(() => {
    if (typeof runner.setAddressListener !== 'function') return () => {};
    runner.setAddressListener(async (address, isCurrent) => {
      if (!isCurrent() || state.manualLanUrl === address) return;
      rememberPreviousDirect();
      await settings.update({ manualLanUrl: address });
    });
    return () => runner.setAddressListener(null);
  }, `${name}: cloudflare address`));
  // 自动启动：上次是启用状态就再拉起；卸载时杀进程但保留 enabled 供下次恢复。
  if (!(host && host.runner)) {
    mount('cloudflare 直连进程', () => ctx.effect(() => {
      if (runner.shouldAutoStart()) void runner.start();
      return () => { void runner.dispose(); };
    }, `${name}: cloudflare runner`));
  }

  return { start, stop, status, syncLocalPort };
}

module.exports = { mountCloudflare };
