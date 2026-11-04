'use strict';

/**
 * CLI 对话的适配器白名单 —— `/api/mobile/v1/cli/*` 能起什么进程的**全部**依据。
 *
 * 与远程终端那份白名单（`mobile/terminal.js` 的 `AGENTS`）是同一档边界，只是走的口子不同：
 * 终端把 CLI 的 TUI 原样搬给手机，这里让 CLI 以 **ACP（Agent Client Protocol）** 的方式跑，
 * 手机收到的是结构化的「消息 / 工具调用 / 审批请求」，于是对话页能像正常对话一样渲染。
 *
 * 四种 CLI 起法有两种：
 *
 *   - `gemini --acp`、`opencode acp`：CLI **自己**就实现了 ACP 服务端，直接起。
 *   - codex / claude：CLI 本身没有 ACP，靠官方 npm 桥（`@agentclientprotocol/*`）。桥包自带
 *     对应的 CLI 依赖、并复用本机登录态，所以本机装没装 `codex` / `claude` 不影响。第一次
 *     用要走 npx 下载，之后走 npm 缓存。
 *
 * **不再多一份「有哪些 CLI」的表**：`cursor-agent` / `aider` 没有 ACP 实现，所以在这一侧
 * 根本不存在 —— 它们仍然只能从终端页进（那一份表在 `terminal.js`，两边各管各的能力面）。
 */

const path = require('node:path');

const { findExecutable } = require('../terminal.js');

/**
 * `transport` 只描述**怎么起**，不代表能力差别：
 *   - `native`：CLI 自带的 ACP 子命令，参数写在 `args`。
 *   - `npx`   ：官方桥包。本机已经全局装了同名可执行就直接用，否则 `npx -y <包名>`。
 */
const AGENTS = [
  {
    id: 'codex',
    label: 'Codex',
    transport: 'npx',
    package: '@agentclientprotocol/codex-acp',
    bin: 'codex-acp',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    transport: 'npx',
    package: '@agentclientprotocol/claude-agent-acp',
    bin: 'claude-agent-acp',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    transport: 'native',
    bin: 'gemini',
    args: ['--acp'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    transport: 'native',
    bin: 'opencode',
    args: ['acp'],
  },
];

function findAgent(id) {
  return AGENTS.find((agent) => agent.id === id) || null;
}

/**
 * 子进程的 PATH。
 *
 * 宿主可能是从 Finder / 应用图标起的，那种进程的 PATH 常常只有 `/usr/bin:/bin`，`npx` 的
 * shebang 是 `#!/usr/bin/env node`，找不着 node 就直接退出。所以把「当前跑宿主的那个 node」
 * 和「适配器所在目录」垫到最前面 —— 只补这两处，不去猜用户 shell 的 PATH。
 */
function childEnv(command, env = process.env) {
  const key = env.PATH !== undefined || env.Path === undefined ? 'PATH' : 'Path';
  const base = env[key] || '';
  const seen = new Set();
  const merged = [path.dirname(process.execPath), path.dirname(command), ...base.split(path.delimiter)]
    .filter((dir) => {
      if (!dir || seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
  return { ...env, [key]: merged.join(path.delimiter) };
}

/**
 * 这台电脑上能不能起这个 CLI。
 *
 * 回 `{ ok: true, command, args }` 或 `{ ok: false, reason }`；`reason` 直接给界面用，所以
 * 是一句人话，不是错误码。
 */
function resolveAgent(agent, env = process.env) {
  if (!agent) return { ok: false, reason: '不认识这个 CLI' };
  try {
    if (agent.transport === 'native') {
      const bin = findExecutable(agent.bin, env);
      if (!bin) return { ok: false, reason: `这台电脑上没有装 ${agent.label}` };
      return { ok: true, command: bin, args: agent.args.slice(), via: 'native' };
    }
    // 桥包已经全局装过就省掉一次 npx 解析；没有就交给 npx 拉（首次会下载，之后走缓存）。
    const installed = findExecutable(agent.bin, env);
    if (installed) return { ok: true, command: installed, args: [], via: 'installed' };
    const npx = findExecutable('npx', env) || findExecutable('npm', env);
    if (!npx) return { ok: false, reason: `这台电脑上没有 npx，装不了 ${agent.label} 的适配器` };
    const args = path.basename(npx) === 'npx' ? ['-y', agent.package] : ['exec', '-y', '--', agent.package];
    return { ok: true, command: npx, args, via: 'npx' };
  } catch {
    return { ok: false, reason: `探测 ${agent.label} 的时候出错了` };
  }
}

module.exports = {
  AGENTS,
  findAgent,
  resolveAgent,
  childEnv,
};
