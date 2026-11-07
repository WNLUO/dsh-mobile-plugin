'use strict';

/**
 * 一个 ACP 适配器子进程 = 一条 CLI 会话的**连接层**。
 *
 * 协议实现用官方库 `@agentclientprotocol/sdk`（稳定 v1 入口），不自己写 JSON-RPC：
 * 那正是这次不做「逐家适配」的关键 —— 四家 CLI 的差别全被适配器吃掉了，这里只认一种协议。
 *
 * 为什么用动态 `import()`：插件这一层是 CJS（`lib/mobile/package.json`），而 SDK 是纯 ESM。
 * 稳定入口的运行时要 zod（`dist/v1/schema/zod.gen.js` 里 `import * as z from "zod/v4"`），
 * 所以 zod 是我们的**直接依赖**，不是可选 peer —— 靠宿主或 profile 里碰巧有一份，
 * 装到关了自动补 peer 的环境里就是「zod 落在安装闭包之外」。
 *
 * `session/update` 一律走 `onNotification` 自己接，**不用** SDK 的 `ActiveSession`：后者会把
 * 每条更新再排进一个内部队列供 `nextUpdate()` 取，我们从不取，等于给每个会话攒一个只涨不
 * 落的数组。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { Readable, Writable } = require('node:stream');

const { childEnv } = require('./agents.js');
const { openImage } = require('./images.js');

/** 握手超时：适配器第一次要 npx 下载，给足；再久就当它起不来了。 */
const START_TIMEOUT_MS = 180000;

/**
 * 报给适配器的客户端身份。
 *
 * `version` **不能省**：ACP 的 `Implementation` 把它标成可选，但 opencode 那边的校验是
 * 必填的 —— 少这一格整条 `initialize` 会回 `-32602 Invalid params`，表现就是界面上一直
 * 「正在启动」（适配器根本没接上）。codex / claude 不挑，所以只有 opencode 会露出来。
 */
const CLIENT_INFO = { name: 'dsh-mobile', version: pluginVersion() };

function pluginVersion() {
  try {
    const version = require('../../package.json').version;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let sdkPromise = null;

function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@agentclientprotocol/sdk');
  return sdkPromise;
}

function noop() {}

/**
 * 起适配器并完成握手，返回一个会话句柄。
 *
 * 失败一律抛错，`message` 是要给用户看的人话（服务层把它变成一条 notice 块 + exit 帧）。
 */
async function startAgent({ spec, cwd, env, onUpdate, onPermission, onStderr, onExit }) {
  const sdk = await loadSdk();
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: env || childEnv(spec.command),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let exited = false;
  child.stdin.on('error', noop);
  child.stdout.on('error', noop);
  child.stderr.on('error', noop);

  let stderrTail = '';
  if (onStderr) {
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-2000);
      onStderr(text);
    });
  }

  child.on('error', (error) => {
    if (exited) return;
    exited = true;
    onExit?.(error && error.message ? error.message : '适配器起不来');
  });

  const app = sdk.client({ name: 'dsh-mobile' });
  app.onRequest(sdk.methods.client.session.requestPermission, async (ctx) => {
    // 适配器等这一个 promise 决定「放不放行」，所以它必须**只有一条** resolve 路径：
    if (!onPermission) return { outcome: { outcome: 'cancelled' } };
    return onPermission(ctx.params);
  });
  app.onNotification(sdk.methods.client.session.update, (ctx) => {
    try {
      onUpdate?.(ctx.params && ctx.params.update);
    } catch { /* 一条更新解析失败不该掐断整条流 */ }
  });

  const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const conn = app.connect(stream);

  conn.closed.then(() => {
    if (exited) return;
    exited = true;
    onExit?.(stderrTail.trim().split('\n').slice(-1)[0] || '适配器退出了');
  }, noop);

  /** 握手整体超时。 */
  const deadline = new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error('适配器启动超时，可能卡在下载或登录上'));
    }, START_TIMEOUT_MS).unref?.();
  });

  let promptCapabilities = null;

  /**
   * 收掉这条连接与它的子进程。
   *
   * 必须定义在握手**之前**：握手失败或超时时这里直接抛错，而那时子进程已经起来了 —— 不在这
   * 条路径上关掉，它就成了一个没人管的孤儿进程（卡在登录界面、还在等输入）。探配置那条路会
   * 反复进来，漏一次就是攒一个进程。
   */
  function kill() {
    try { conn.close(); } catch { /* 已经关了 */ }
    try { child.kill('SIGTERM'); } catch { /* 已经退出 */ }
  }

  let session;
  try {
    session = await Promise.race([
      (async () => {
        const initialized = await conn.agent.request(sdk.methods.agent.initialize, {
          protocolVersion: sdk.PROTOCOL_VERSION,
          // 不认领文件系统与终端能力：四家 CLI 都有自己的文件访问，我们替它读写反而要多做
          // 一套实现，做漏了就是一条静默失败的路。
          clientCapabilities: { terminal: false },
          clientInfo: CLIENT_INFO,
        });
        // 这家认不认图片输入：握手时它自己说。不说就按「不支持」处理 —— 硬塞 image 块过去，
        // 有的适配器会直接回一条参数错误，把整轮提问连正文一起废掉。
        promptCapabilities = (initialized && initialized.agentCapabilities && initialized.agentCapabilities.promptCapabilities) || null;
        const created = await conn.agent.request(sdk.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        return { sessionId: created.sessionId, created };
      })(),
      deadline,
    ]);
  } catch (error) {
    kill();
    throw error;
  }

  return {
    child,
    sessionId: session.sessionId,
    created: session.created,
    /**
     * 会话创建时给出的可配置项（模型 / 思考档 / 权限模式…）与模式表。
     *
     * ACP 把它们定成「客户端画一组下拉、选中就回一条 set」，各家 CLI 的差别全被吃掉：
     * opencode 把模型放在 `configOptions`，claude 把模式放在 `modes`，codex 两者都给。
     * 所以手机上的「选模型」不需要为每家写一套，照着这两张表画就行。
     */
    configOptions: Array.isArray(session.created.configOptions) ? session.created.configOptions : [],
    modes: session.created.modes ?? null,
    /** 这家认不认图片输入（握手时它自己声明的 `promptCapabilities.image`）。 */
    get supportsImages() { return Boolean(promptCapabilities && promptCapabilities.image); },
    get alive() { return !exited; },
    /**
     * 发一轮提问；resolve 时这一轮结束（ACP 的 `session/prompt` 就是这么定的）。
     *
     * `images` 是已经存好的图片元数据（`{ attachmentId, mediaType }`）：按 ACP 的 image 块
     * 发过去 —— `{type:'image', data, mimeType}`，字节在这一次请求里内联（ACP 只有这一种
     * 传法，没有「你自己去读这个路径」的入口，我们也没认领 fs 能力）。
     */
    prompt(text_, images) {
      const blocks = [];
      for (const image of Array.isArray(images) ? images : []) {
        const stored = openImage(image && image.attachmentId);
        if (!stored) continue;
        try {
          blocks.push({
            type: 'image',
            data: fs.readFileSync(stored.path).toString('base64'),
            mimeType: stored.mediaType || image.mediaType || 'image/png',
          });
        } catch { /* 读不出来就只丢这一张，正文照发 */ }
      }
      if (text_) blocks.push({ type: 'text', text: text_ });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      return conn.agent.request(sdk.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: blocks,
      });
    },
    cancel() {
      return conn.agent.notify(sdk.methods.agent.session.cancel, { sessionId: session.sessionId });
    },
    /** 改一项配置（选模型 / 换思考档）。`configId` 就是 `configOptions[].id`。 */
    setConfigOption(configId, value) {
      return conn.agent.request(sdk.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId,
        value,
      });
    },
    /** 换模式（claude 的 Manual / Accept edits / Plan 那一组）。 */
    setMode(modeId) {
      return conn.agent.request(sdk.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId,
      });
    },
    close() {
      // 会话收尾是尽力而为：适配器不支持 `session/close` 就直接断进程。
      try {
        conn.agent.request(sdk.methods.agent.session.close, { sessionId: session.sessionId }).catch(noop);
      } catch { /* 同上 */ }
      kill();
      setTimeout(kill, 1500).unref?.();
    },
    kill,
  };
}

module.exports = { startAgent, loadSdk, START_TIMEOUT_MS };
