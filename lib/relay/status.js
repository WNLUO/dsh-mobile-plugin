'use strict';

/**
 * 中转状态视图：把「此刻这台宿主到底怎么样」拼成一份 JSON。
 *
 * 这份 JSON 有三个消费方，形状必须一模一样：桌面设置页、手机首屏都轮询
 * `/api/mobile/v1/status`，二维码里嵌的也是它的子集。抽出来之后可以直接 require 测试，
 * index.js 只剩装配。
 *
 * `TUNNEL_ADMISSION` 靠正则匹配中转返回的错误文案来判断隧道为什么被拒。这是个脆弱契约
 * （中转改一个字就漏判），但错误文案是当前唯一穿过隧道边界回来的信号，判定放宽到只认关键词。
 */

const os = require('node:os')

// 版本号只有一个来源：包自己的 package.json。以前 index.js 与 hostMetadata() 各拼一次。
const { version: pluginVersion } = require('../../package.json')

// 客户端半边（桌面页面里的 lib/client.js）的活体台账，只读它的计数快照。
const desktopHalf = require('../desktop-half-stats.cjs')

const TUNNEL_ADMISSION = [
  {
    // 中转关连接时用的文案是 'bad registration secret'（server.js 里拼的），
    // 而 lib/tunnel-registration.js 内部的 reason 拼作 'bad register secret'。
    // 两种拼法都出现过，所以正则认词干不认具体字母：regist + 任意尾巴 + secret。
    pattern: /bad regist\w*\s+secret/i,
    flag: 'registerSecretRequired',
    // 这两条拒绝都由 server.js 的准入判定给出（lib/tunnel-registration.js），
    // 文案变了这里就会漏判，所以判定正则放宽到只认关键词。
    //
    // 插件每 5 秒重试一次，而状态里只有一句「隧道关闭: 1008 bad registration secret」。
    // 那句话不指向任何可执行动作——第一次上手的人（以及帮他的人）只能看着它干瞪眼：
    // 值从哪儿来、去哪儿填，代码里一个字都没有。
    //
    // 这里必须说清楚一件不好听的事：注册密钥是**中转服务器的部署参数**，只存在于它的
    // systemd unit（Environment=TUNNEL_REGISTER_SECRET=…）或 instances.json 里，
    // 中转不通过任何接口把它公开出去。所以客户端能给出的最好答案就是「向部署者索取，
    // 填进设置页的『注册密钥』」——拿不到就说拿不到，不假装有自助路径。
    hint: 'register-secret',
  },
  {
    pattern: /unknown instance/i,
    flag: 'instanceNotAllowed',
    hint: 'instance-allowlist',
  },
]

/** 给隧道快照补上「为什么被拒」的可执行线索；正常状态原样返回。 */
function describeTunnel(snapshot) {
  const base = snapshot || { state: 'off', error: null }
  if (base.state !== 'error' || !base.error) return base
  const hit = TUNNEL_ADMISSION.find((entry) => entry.pattern.test(String(base.error)))
  return hit ? { ...base, [hit.flag]: true, admissionHint: hit.hint } : base
}

function hostMetadata() {
  return {
    os: process.platform,
    // `os` is the legacy field name; `platform` is canonical so mobile clients
    // never confuse the host's OS with their own.
    platform: process.platform,
    osVersion: os.release(),
    arch: process.arch,
    appVersion: pluginVersion,
  }
}

/**
 * @param {object} deps
 * @param {object} deps.state 内存里的中转状态（const 对象，就地改）
 * @param {number} deps.webServerPort
 * @param {() => object} deps.getSidecarSnapshot 取值器，不是对象：sidecarSnapshot
 *   会被 applySidecarConfig 整体替换，闭包捕获对象会永远读到旧快照。
 * @param {() => number} deps.lanPortInUse 本进程解析出的实际端口
 * 其余都是 apply() 闭包里会被重新赋值的 let，用取值器读。
 */
function createStatusView(deps) {
  const {
    state,
    webServerPort,
    getSidecarSnapshot,
    lanPortInUse,
    getLanPortAdjusted,
    getSidecarState,
    getSidecarRestarts,
    getSidecarRestartedAt,
    getSidecarRestartError,
    getMirrorPush,
  } = deps

  return function status() {
    const sidecarSnapshot = getSidecarSnapshot()
    const lanPortAdjusted = getLanPortAdjusted()
    const mirrorPush = getMirrorPush()
    return {
      enabled: state.enabled,
      instanceId: state.instanceId,
      pairingCode: state.pairingCode,
      relayUrl: state.relayUrl,
      name: state.name,
      pairingPolicy: state.pairingPolicy === 'deny' ? 'deny' : 'code',
      // 首次接入引导走完没有。面板（lib/panel 里那份 React 页面）据此决定打开时
      // 先走引导还是直接进主页；`enabled` 也算「配过了」，所以老机器升级上来不会
      // 突然被拦一次引导（它们的 relay.json 里没有这个键，读到的是 undefined）。
      onboarded: state.onboarded === true,
      ...hostMetadata(),
      localPort: webServerPort,
      tunnel: describeTunnel(sidecarSnapshot.tunnel),
      // 以本进程解析出的实际端口为准：sidecar 的快照里 `port` 才是最终 bind 成功的
      // 那个（它在 listen 之后才拿得到），而这里在探测阶段就已经知道了，两个值一致
      // 才不会让状态接口和二维码互相打架。
      lan: {
        ...(sidecarSnapshot.lan || {}),
        port: lanPortInUse(),
        adjusted: lanPortAdjusted,
        requestedPort: state.lanPort,
      },
      sidecar: {
        state: getSidecarState(),
        // 自重启能换掉哪一层、换不掉哪一层，写在这里而不是只写在文档里：
        // 「重启了」不等于「所有改动都生效」，这个区分必须能在状态接口上直接看到。
        scope: {
          worker: 'restartable',
          facade: 'restartable',
          // 宿主侧模块（lib/index.js、lib/client.js、lib/mobile/*）已挂在 fiber 上，
          // 摘不掉，只能重启 DSH 宿主。
          host: 'needs-host-restart',
        },
        restarts: getSidecarRestarts(),
        restartedAt: getSidecarRestartedAt() || 0,
        restartError: getSidecarRestartError(),
      },
      mirror: { pushedAt: mirrorPush.pushedAt || 0, ok: mirrorPush.ok, error: mirrorPush.error },
      // 桌面页面里的客户端半边「有没有来敲过门」：绿点两条同步通道都是单向轮询 + 无回执，
      // 这里的三组计数是唯一的活体证据（对照关系见 lib/desktop-half-stats.cjs 的文件头）。
      desktopHalf: desktopHalf.snapshot(),
    }
  }
}

module.exports = { TUNNEL_ADMISSION, describeTunnel, hostMetadata, createStatusView }