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
 *     对应的 CLI 依赖、并复用本机登录态，所以本机装没装 `codex` / `claude` 不影响。
 *
 * **这张表是兜底，不是清单本身**：真正「能起哪些」来自官方 ACP 注册表（见 `cli/registry.js`），
 * 注册表里走 npx 分发的都能起，新 CLI 上线不必我们发版。下面这四条是它的降级档 —— 离线、
 * 注册表拉不到、盘上也没有缓存时，仍然有四家用，而不是一个空清单。
 *
 * 内置这四条**永远出现在清单里**（它们是本仓维护的那一档，桥包由 npx 按需拉）；注册表补进来
 * 的那些则要求「这台电脑上真的装了」——见 `installedPackages`。
 *
 * `cursor-agent` / `aider` 没有 ACP 实现，所以在这一侧根本不存在 —— 它们仍然只能从终端页进
 * （那一份表在 `terminal.js`，两边各管各的能力面）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findExecutable } = require('../terminal.js');

/**
 * `transport` 只描述**怎么起**，不代表能力差别：
 *   - `native`：CLI 自带的 ACP 子命令，参数写在 `args`。
 *   - `npx`   ：官方桥包。本机已经全局装了同名可执行就直接用，否则 `npx -y <包名>`。
 *
 * `package` 是 npx 分发那一档的包名（注册表里可能带版本，原样收着：版本由注册表钉住）。
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

/** 去掉 `@scope/name@1.2.3` 尾部的版本，得到 npm 认的包名。 */
function barePackage(pkg) {
  const name = String(pkg || '').trim();
  if (!name) return '';
  // `@scope/name@1.2.3` / `name@1.2.3`：最后一个 `@` 在首位之后才是版本分隔。
  const at = name.lastIndexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}

/** 一个 `node_modules` 目录下有没有这个包（两段式名字按第一段进一层）。 */
function hasPackageIn(dir, name) {
  try {
    const stat = fs.statSync(path.join(dir, name));
    return stat.isDirectory();
  } catch {
    try {
      return fs.statSync(path.join(dir, name, 'package.json')).isFile();
    } catch {
      return false;
    }
  }
}

/**
 * 这台电脑上已经装了的 npm 包（只认名字，一份 Set）。
 *
 * 为什么要它：注册表里有二十来家能 npx 拉起的 ACP 适配器，全列出来等于给用户看一屏他从没
 * 装过的东西 —— 点下去要么下载几十秒，要么卡在登录上。手机上要的是「这台电脑现在能聊哪些」。
 *
 * 三个来源，全是读目录（不 spawn npm，列一次清单不该等一个子进程）：
 *
 *   1. 跑宿主的那个 node 旁边的 `lib/node_modules`（Homebrew / 官方安装包的路子）；
 *   2. `NPM_CONFIG_PREFIX` 指的全局根（用户自己配过的）；
 *   3. `~/.npm/_npx` 下每一份 `node_modules`（npx 拉过一次就留在那儿，桥包通常就在这一档）。
 *
 * 探不到就返回空集 —— 那种情况下注册表那一条当「没装」处理，内置四条照旧在。
 */
function installedPackages(env = process.env) {
  const roots = [];
  if (env.NPM_CONFIG_PREFIX) roots.push(path.join(env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'));
  if (env.NPM_GLOBAL_ROOT) roots.push(env.NPM_GLOBAL_ROOT);
  roots.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
  const npxCache = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const entry of fs.readdirSync(npxCache)) {
      roots.push(path.join(npxCache, entry, 'node_modules'));
    }
  } catch {
    // 没有 npx 缓存目录就是没走过 npx：不影响别的来源。
  }

  const names = new Set();
  for (const dir of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        let scoped = [];
        try { scoped = fs.readdirSync(path.join(dir, entry)); } catch { continue; }
        for (const child of scoped) names.add(`${entry}/${child}`);
        continue;
      }
      names.add(entry);
    }
  }
  return names;
}

/** 这个包在这台电脑上装了没有（`bin` 在 PATH 里也算装了 —— 那是同一件事的另一半）。 */
function isInstalled(agent, installed, env = process.env) {
  if (!agent) return false;
  if (agent.bin && findExecutable(agent.bin, env)) return true;
  const name = barePackage(agent.package);
  return Boolean(name && installed && installed.has(name));
}

/**
 * 这台电脑上能不能起这个 CLI。
 *
 * 回 `{ ok: true, command, args, via }` 或 `{ ok: false, reason }`；`reason` 直接给界面用，
 * 所以是一句人话，不是错误码。
 *
 * `ok` 说的是「现在点得下去、起得来」：`npx` 那一档只要本机有 npx 就成立（首次会下载桥包，
 * 之后走缓存）。要不要把它列进选择卡是另一件事，由 `isInstalled` 判（见 `service.listAgents`）。
 *
 * `npx` 那一档的参数要跟着一起给：注册表里不少包本身不是 ACP 服务端，得靠自己的子命令进
 * ACP 模式（`cline --acp`、`bob acp`、`droid exec --output-format acp-daemon`）。只给包名
 * 的话进程起来就是一个普通 CLI，握手永远等不到 —— 表现是「一直在启动」。
 */
function resolveAgent(agent, env = process.env) {
  if (!agent) return { ok: false, reason: '不认识这个 CLI' };
  try {
    const extra = Array.isArray(agent.args) ? agent.args.filter((arg) => typeof arg === 'string') : [];
    if (agent.transport === 'native') {
      const bin = findExecutable(agent.bin, env);
      if (!bin) return { ok: false, reason: `这台电脑上没有装 ${agent.label}`, via: 'native' };
      return { ok: true, command: bin, args: extra, via: 'native' };
    }
    // 桥包已经全局装过就省掉一次 npx 解析；没有就交给 npx 拉（首次会下载，之后走缓存）。
    const installedBin = agent.bin ? findExecutable(agent.bin, env) : null;
    if (installedBin) return { ok: true, command: installedBin, args: extra, via: 'installed' };
    const npx = findExecutable('npx', env) || findExecutable('npm', env);
    if (!npx) return { ok: false, reason: `这台电脑上没有 npx，起不了 ${agent.label}` };
    const args = path.basename(npx) === 'npx'
      ? ['-y', agent.package, ...extra]
      : ['exec', '-y', '--', agent.package, ...extra];
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
  installedPackages,
  isInstalled,
  barePackage,
};
