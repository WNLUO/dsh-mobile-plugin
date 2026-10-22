'use strict';

/**
 * 自己装新版：在 profile 里跑一次它**自己的**包管理器，把本插件换到指定版本。
 *
 * ## 为什么不借道 DSH 插件市场
 *
 * 插件的更新分两步：**查**（线上最新是几，见 `update-registry.cjs`）和**装**（把新版本真的
 * 落到这台机器的 profile 里）。2026-10-11 之前「装」是请市场代劳的（打它的
 * `/dsh-market/api/v1/updates`，等它跑完 pnpm 再问结果）。用户的判断是：这件事插件应该
 * 自己完成，不该因为「另一个插件没装 / 太老 / 坏了」就整个失效。这里就是那一步。
 *
 * ## 关键：不自己实现包管理，只**驱动**它
 *
 * profile 里装插件用的是 pnpm，而且 profile 自己的 `pnpm-workspace.yaml` 已经写好了所有
 * 关键设置（`node-linker=hoisted`、`auto-install-peers=false`、`minimum-release-age-exclude`
 * 那些按包放行的条目）。所以这里是「cd 到 profile，跑一句 `pnpm add <包名>@<版本>`」——
 * **不传布局类开关**，让它按 profile 的既有配置来，免得把别人的布局改写掉。市场那套
 * （`pnpm-compat.js` + `install.js`）几千行都在处理 pnpm 各版本的旗标拼写、hoist 恢复、
 * 镜像/超时/Windows shim 这些边角；这里刻意**只做我们自己这条路上必须的那两三个开关**，
 * 剩下的交给 profile 自己的配置。
 *
 * ## 用哪个包管理器：**宿主给的那个优先**
 *
 * 2026-10-11 真机踩到：这台机器 PATH 上的 pnpm 是 10.x（store v10），而 profile 是**宿主
 * 自带的** pnpm 11.x（store v11）装的，拿 PATH 那个去装直接 `ERR_PNPM_UNEXPECTED_STORE`。
 * 所以顺序是「宿主发布的调用方式 → PATH 上的 pnpm → npm」，见 `normalizeInvocation`。
 *
 * ## 三个开关，每个都有理由
 *
 * · `--config.auto-install-peers=false`：本插件的 peer 里有一串 `@deepseek-ai/*`
 *   （`cordis`、`dsh-tools`、`dsh-client-runtime`…），它们是 **DSH 运行时注入的、npm 上
 *   根本没有**。pnpm 8 起 `auto-install-peers` 默认开，会去 npm 上拉这些 peer 然后 404。
 *   profile 里通常已经关掉了，但那是市场帮它写的 —— 换台机器不一定有，所以这里显式带上。
 * · `--config.minimum-release-age=0`：**撞上 pnpm 的「新发布先晾一会儿」策略时才带**。
 *   强制更新（`force`）一开始就带；平时不带，但**失败信息确实是这类策略时会带开关重试一次**
 *   —— 那道策略查的是**整份 lockfile**，别的插件刚发不久也会把整份锁文件判成「含未过期
 *   条目」，于是我们自己的更新整整一天都做不了，而原因跟我们这个包毫无关系（2026-10-11
 *   真机撞上的就是 `billion-context@0.1.192`）。市场那边对这种拒绝同样是带开关重试一次。
 * · `CI=1`：没有终端可交互。包管理器在无人值守的子进程里问问题是没法回答的。
 *
 * ## 装之前先看有没有 agent 在跑（但「有没有新版」排在它前面）
 *
 * 装是**就地替换插件文件**，正在干活的对话可能读到半个包。市场那条路有一道这样的闸
 * （`AGENTS_RUNNING`），这里也补上了 —— 判到有人跑就**不动盘**，如实报成「可再试」。
 * `force`（面板上的「强制更新」）是用户明说「我知道，装吧」的那一挡，会跳过它。
 *
 * 顺序上**先答「有没有新版」**：没东西可装时拿一句「有对话在跑」挡在前面是误导，用户会以为
 * 是那个原因，而真正的答案是「已经是最新」。
 *
 * ## 边界（照实说）
 *
 * · **只动 profile 的依赖树**（`pnpm add` 会顺手把 profile 的 `package.json` 里的依赖声明
 *   也更新掉——那正是「装上了」的凭据）。不碰仓库、不碰 `~/.dsh` 里别的东西。
 * · **找不到包管理器就如实失败**，不猜、不回退到「假装装好了」。桌面端由 GUI 拉起时 PATH
 *   往往很干净（LaunchServices 只给 `/usr/bin:/bin` 之类），所以这里照市场的做法补一组
 *   常见 bin 目录再找，见 `toolSearchDirs`。
 * · 装完**以盘上的版本号为准**：`installedVersion` 没变就是没装上，哪怕命令退出码是 0。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { checkForUpdate } = require('./update-registry.cjs');

/** 本插件的 npm 包名（`package.json` 的 name）。 */
const DEFAULT_NAME = 'dsh-mobile-plugin';

/** 一次安装的上限：pnpm 装一个包 + 拉依赖，给足但别无限等。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** 命令输出留多少字符（日志与错误信息里给个人看得懂的尾巴）。 */
const OUTPUT_TAIL = 4000;

/**
 * 去哪儿找包管理器。
 *
 * 与市场那份（dshmarket 的 `dsh-cli.js` `toolSearchDirs`）**故意保持一致**：桌面端由 GUI
 * 或 Dock 拉起时继承不到 shell 的 PATH，pnpm 常常不在其中，而这一组目录覆盖了官方安装器
 * 与 Homebrew / npm -g 的落点。`PNPM_HOME` 放最前面：安装器设了它，那是最准的答案。
 */
function toolSearchDirs({ platform = process.platform, env = process.env, home = os.homedir(), execDir = path.dirname(process.execPath) } = {}) {
  const dirs = [];
  const pnpmHome = typeof env.PNPM_HOME === 'string' ? env.PNPM_HOME.trim() : '';
  if (pnpmHome) dirs.push(pnpmHome);
  if (platform === 'win32') {
    const local = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
    const roaming = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : '';
    if (local) dirs.push(path.join(local, 'pnpm'));
    if (roaming) dirs.push(path.join(roaming, 'npm'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'));
    dirs.push(path.join(home, 'Library', 'pnpm'), path.join(home, '.local', 'share', 'pnpm'));
    dirs.push(path.join(home, '.npm-global', 'bin'));
  }
  dirs.push(execDir);
  return [...new Set(dirs.filter(dir => typeof dir === 'string' && dir.trim() !== ''))];
}

/** 找一个能跑的可执行文件：先给的那几组目录，再 PATH。Windows 上认 `.cmd` 后缀。 */
function resolveExecutable(command, dirs, { platform = process.platform, env = process.env } = {}) {
  const names = platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  const fromPath = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of [...dirs, ...fromPath]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // 不存在就下一个。
      }
    }
  }
  return null;
}

/** 把补出来的目录接在 PATH 前面（子进程里的 pnpm 还要再 spawn 它自己的东西）。 */
function spawnEnv(dirs, env = process.env) {
  const existing = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  return { ...env, PATH: [...dirs, ...existing].join(path.delimiter), CI: env.CI || '1' };
}

/** profile 里装着的那份插件包的版本号（读不到返回 null）。 */
function installedVersion(profileNodeModules, name = DEFAULT_NAME) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileNodeModules, name, 'package.json'), 'utf8'));
    return typeof raw.version === 'string' && raw.version ? raw.version : null;
  } catch {
    return null;
  }
}

/**
 * profile 的依赖声明里这个包是怎么装的（`profileDir` 是 profile 根，不是它的 node_modules）。
 *
 * 读不到就说不知道（null），不要瞎猜。
 */
function declaredSource(profileDir, name = DEFAULT_NAME) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const spec = raw?.dependencies?.[name] ?? raw?.devDependencies?.[name];
    if (typeof spec !== 'string') return null;
    if (spec.startsWith('link:')) return 'linked';
    if (spec.startsWith('file:')) return 'file';
    if (spec.startsWith('workspace:')) return 'workspace';
    return 'npm';
  } catch {
    return null;
  }
}

/** 「只有从注册表装的，才由注册表来更新」——其余装法一律不碰盘。 */
const REGISTRY_SOURCES = new Set(['npm']);

/**
 * 一次安装请求能不能动盘。
 *
 * 判据是 profile 里**声明的来源**，不是「装没装得上」：`link:` 指向本地目录（开发时故意
 * 指过去的）、`file:` 指向本机打出来的 tgz（开发版）、`workspace:` 指向本仓库的包——
 * 这三种都是有人**明确安排**的装法，装一次注册表版会把那个指向悄悄改掉，而这正是开发机
 * 上最不想要的一次覆盖：改完一轮代码，后台自己把 npm 版装回来，然后所有本地改动「明明
 * 改了却没生效」。
 *
 * 所以「能不能点更新」这一格由来源决定，不由外部命令决定：非注册表来源**连试都不试**，
 * 如实回一个稳定错误码，让人知道这台是怎么更新的（插件自己的改动只能由改代码的人来推）。
 *
 * 读不到来源（profile 里没有这条依赖，或文件坏了）不算已知来源：那种现场通常意味着
 * 插件压根不是从 profile 装的，装一次反而是「修复」，所以放行。
 *
 * @param {string|null} source - `declaredSource` 的结果。
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function installAllowedFor(source) {
  if (source === null || REGISTRY_SOURCES.has(source)) return { ok: true };
  const how = source === 'linked' ? 'link: 一个本地目录'
    : source === 'file' ? 'file: 一个本机打出来的包'
      : source === 'workspace' ? 'workspace: 本仓库里的包'
        : `来源 ${source}`;
  return {
    ok: false,
    code: 'LOCAL_SOURCE',
    message:
      `这个插件在 profile 里是 ${how}（${source}）装的，是有意为之：改成注册表版会把那个指向换掉，`
      + '本地的改动就再也不生效了。所以这里既不检查也不安装 —— 这一台的插件更新由改代码的人来做'
      + '（同步文件后让宿主就地重载）；要换回按版号安装，先在插件市场里按包名重装一次。',
  };
}

/**
 * 宿主**发布出来**的包管理器调用方式（DSH 桌面版把它挂在 `profileContext.packageManager`
 * 上，形状 `{command, args, env?}`）。
 *
 * 为什么非得用它、而不是 PATH 上那个 pnpm：桌面版由 GUI 拉起时 PATH 很干净，而且**版本
 * 可能对不上** —— 实测这台机器上 PATH 的 pnpm 是 10.x（store v10），而 profile 是宿主自带的
 * pnpm 11.x（store v11）装的，用它装会直接 `ERR_PNPM_UNEXPECTED_STORE`。市场那边也是
 * 「宿主给的那个优先，找不到才退回 PATH 和 corepack」（`dsh-cli.js` 的 `probePnpm`）。
 *
 * 形状有一格不对就整个丢掉（半份调用等于仍然跑不起来的工具）；`env` 只收字符串值。
 */
function normalizeInvocation(published) {
  if (published === null || typeof published !== 'object' || Array.isArray(published)) return null;
  const { command, args, env } = published;
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return null;
  const merged = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') merged[key] = value;
  }
  return { command: command.trim(), args: [...args], env: merged };
}

/**
 * 此刻正在跑的 agent（`status === 'running'` 的那些）。
 *
 * 判据与市场那份（`dshmarket` 的 `agents.js`）逐字一致：`agents.list()` 里 `status` 正好是
 * `'running'` 的才算，列表读不到或抛错一律当「没有」—— 守卫宁可放过，也不能因为读不到状态
 * 就把更新整个锁死。**不排除调用者自己**：这正是「有对话在跑就别换插件文件」的意思。
 */
function runningAgentIds(agents) {
  if (agents === null || agents === undefined) return [];
  let listed;
  try {
    listed = typeof agents.list === 'function' ? agents.list() : null;
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const ids = [];
  for (const agent of listed) {
    if (agent === null || typeof agent !== 'object' || agent.status !== 'running') continue;
    const id = typeof agent.id === 'string' && agent.id !== '' ? agent.id : 'agent';
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 跑一条命令，收 stdout+stderr 的尾巴。超时或非零退出码都如实带出来。 */
function run(command, args, { cwd, env, timeoutMs, spawnImpl = spawn }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, output: '', error: String(error?.message || error) });
      return;
    }
    let output = '';
    const collect = chunk => {
      output += String(chunk);
      if (output.length > OUTPUT_TAIL * 2) output = output.slice(-OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经退出了。
      }
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output, error: String(error?.message || error) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.slice(-OUTPUT_TAIL), error: null });
    });
  });
}

/**
 * 装一次：把 <name> 换到 <version>。
 *
 * @param {object} options
 * @param {string} options.profileNodeModules profile 的 `node_modules` 目录
 * @param {string} options.version           要装的版本（注册表给的）
 * @param {boolean} [options.force]          true = 跳过「新发布先晾一会儿」的门槛
 * @param {() => any} [options.beforeInstall] 真正跑包管理器**之前**调一次（外壳用它把正在跑的
 *   那一代复制进回退目录）。包管理器一跑就把旧的 store 目录清掉了，晚一步没得复制。
 * @returns {Promise<{installed, skipped, beforeVersion, installedVersion, source, command, output, failure}>}
 */
async function installLatest({
  profileNodeModules,
  version,
  name = DEFAULT_NAME,
  force = false,
  timeoutMs = INSTALL_TIMEOUT_MS,
  env = process.env,
  platform = process.platform,
  // 去哪儿找包管理器。默认那组见 `toolSearchDirs`；注入只为测试。
  dirs = null,
  // 宿主发布的调用方式（`profileContext.packageManager`）。**优先用它**，理由见
  // `normalizeInvocation` 的文件注释（版本对不上会把 profile 的 store 认错）。
  packageManager = null,
  beforeInstall = null,
  onEvent = () => {},
} = {}) {
  const beforeVersion = installedVersion(profileNodeModules, name);
  const profileDir = path.dirname(profileNodeModules);
  const searchDirs = dirs ?? toolSearchDirs({ platform, env });
  const hostInvocation = normalizeInvocation(packageManager);
  const childEnv = spawnEnv(searchDirs, env);

  const fail = (code, message) => ({
    installed: false,
    skipped: false,
    beforeVersion,
    installedVersion: installedVersion(profileNodeModules, name),
    source: declaredSource(profileDir, name),
    command: null,
    output: '',
    failure: { code, message },
  });

  /**
   * 来源那道门排在**挑包管理器之前**：非注册表来源连 `pnpm --version` 都不该跑一次 ——
   * 那一步只是探活，但排在前面会让「这台根本不该装」和「这台装不了」混成同一种失败。
   */
  const source = declaredSource(profileDir, name);
  const gate = installAllowedFor(source);
  if (!gate.ok) return fail(gate.code, gate.message);

  /**
   * 挑一个能用的包管理器：**宿主给的那个先试**（探一次 `--version`，跑不起来就当没有），
   * 之后才是 PATH 上的 pnpm / npm。返回 `{command, prefix, manager, kind}`。
   */
  async function pickManager() {
    if (hostInvocation) {
      const probe = await run(hostInvocation.command, [...hostInvocation.args, '--version'], {
        cwd: profileDir,
        env: { ...childEnv, ...hostInvocation.env },
        timeoutMs: 20000,
      });
      if (probe.ok) {
        return { command: hostInvocation.command, prefix: hostInvocation.args, manager: 'pnpm', kind: 'host', env: hostInvocation.env };
      }
      onEvent({ phase: 'host-manager-unusable', output: probe.output });
    }
    const pnpm = resolveExecutable('pnpm', searchDirs, { platform, env });
    if (pnpm) return { command: pnpm, prefix: [], manager: 'pnpm', kind: 'path', env: {} };
    const npm = resolveExecutable('npm', searchDirs, { platform, env });
    if (npm) return { command: npm, prefix: [], manager: 'npm', kind: 'path', env: {} };
    return null;
  }

  const picked = await pickManager();
  if (!picked) {
    return fail(
      'PACKAGE_MANAGER_MISSING',
      '这台机器上找不到能用的包管理器（宿主没发布、PATH 上也没有 pnpm / npm），装不了新版。' +
        '装一个 pnpm（或 npm）之后重试；插件不会自己去下载解包 —— 那等于把包管理器的活抄一遍，' +
        '抄漏一处就是装出半个包。',
    );
  }

  // 备份正在跑的那一代：包的活就落在下面那一行 spawn 上，它一跑旧目录就没了。
  // 备份失败不该挡住更新（那是多一层保险），所以这里吞掉它的异常，由调用方记日志。
  if (typeof beforeInstall === 'function') {
    try {
      await beforeInstall({ beforeVersion, command: null });
    } catch { /* 备份失败不挡更新 */ }
  }

  const spec = `${name}@${version}`;
  const releaseAgeFlag = '--config.minimum-release-age=0';
  const args = picked.manager === 'pnpm'
    ? ['add', spec, '--config.auto-install-peers=false', ...(force ? [releaseAgeFlag] : [])]
    : ['install', spec, '--no-audit', '--no-fund'];
  let command = [picked.manager, ...args].join(' ');
  onEvent({ phase: 'install-started', command, manager: picked.kind });

  const spawnAdd = extra => run(picked.command, [...picked.prefix, ...args, ...extra], {
    cwd: profileDir,
    env: { ...childEnv, ...picked.env },
    timeoutMs,
  });
  let result = await spawnAdd([]);
  let output = result.output;
  /**
   * 撞上 pnpm 的「新发布先晾一会儿」策略：**带上开关重试一次**。
   *
   * 为什么非重试不可：那道策略查的是**整份 lockfile**，不是我们要装的这个包。这台机器上
   * 实测过一次 —— 另一个插件（`billion-context@0.1.192`）刚发不久，整份 lockfile 就被判
   * 「含未过期的条目」而拒绝，于是我们自己的更新整整一天都做不了，而原因跟我们这个包毫无
   * 关系。市场那边对这种拒绝也是带开关重试一次（`RELEASE_AGE_OVERRIDE`）。
   *
   * 只在**第一次没带开关**、且失败信息确实是这类策略时才重试：别的失败（网络、权限、盘满）
   * 重试一次只会把同一条错误再说一遍，还多花一次等待。
   */
  const releaseAgeLike = /MINIMUM_RELEASE_AGE|minimumReleaseAge|minimum-release-age|release age/i;
  const retried = !result.ok && picked.manager === 'pnpm' && !force && releaseAgeLike.test(output);
  if (retried) {
    onEvent({ phase: 'release-age-retry' });
    result = await spawnAdd([releaseAgeFlag]);
    command = [picked.manager, ...args, releaseAgeFlag].join(' ');
    output = `${output}\n--- 撞上 pnpm 的发布时长策略，带上 ${releaseAgeFlag} 重试一次 ---\n${result.output}`;
  }
  const after = installedVersion(profileNodeModules, name);
  if (!result.ok) {
    return {
      installed: false,
      skipped: false,
      beforeVersion,
      installedVersion: after,
      source: declaredSource(profileDir, name),
      command,
      manager: picked.kind,
      retried,
      output,
      // 超时与「真的失败了」分开说：前者可以再试，后者多半要看输出。
      failure: {
        code: result.code === null ? 'INSTALL_ABORTED' : 'INSTALL_FAILED',
        message: `${command} ${result.code === null ? '没能跑完' : `退出码 ${result.code}`}${result.error ? `：${result.error}` : ''}`,
      },
    };
  }
  // 退出码 0 不算数：**盘上版本真的变了**才算装上（市场那份代码吃过这个亏）。
  const changed = after !== null && after !== beforeVersion;
  return {
    installed: changed,
    skipped: false,
    beforeVersion,
    installedVersion: after,
    source: declaredSource(profileDir, name),
    command,
    manager: picked.kind,
    retried,
    output,
    failure: changed
      ? null
      : { code: 'VERSION_UNCHANGED', message: `${command} 跑完了，但盘上还是 ${after ?? '读不到版本'}，这一次不算数` },
  };
}

/**
 * 「让我变成最新」：先看这台是不是注册表来源，再看有没有人在干活，最后决定装不装。
 *
 * 面板那颗按钮**与外壳的自动更新**都打这个入口 —— 两处走同一套判定，免得出现「手动说有
 * 新版、自动说没有」这种最难查的偏差。已经是最新（`force` 为假）就什么都不做、如实报
 * `skipped`。
 *
 * ## 为什么来源排在第一位
 *
 * 只有从注册表装的包才该由注册表来更新。`link:` / `file:` / `workspace:` 是有人**明确
 * 安排**的装法（开发机就是这么跑的），装一次注册表版会把那个指向悄悄换掉 —— 表现为「明明
 * 改了代码却没生效」，而改代码的人还以为是缓存。`force` 也过不去这一关：这不是「现在不行」，
 * 是「这台不该这么装」。
 *
 * ## 为什么装之前先看有没有 agent 在跑
 *
 * 装会**就地换掉插件文件**（profile 里那一份），而正在干活的对话可能正好在装配/读取插件
 * 目录 —— 换到一半就是「读到半个包」。市场那条路也有同一道闸（`AGENTS_RUNNING`），这条是
 * 把它搬到插件自己这条路上来。判到有人跑就**不动盘**，如实报成「可再试」，下个 tick 再来。
 *
 * `force` 是**用户明说「我知道，装吧」**的那一挡（面板上那颗「强制更新」）：它同时跳过
 * 这道闸和「新发布先晾一会儿」的门槛。自动更新永远不带 force。
 */
async function installLatestIfNeeded(options = {}) {
  const { profileNodeModules, force = false, name = DEFAULT_NAME, agents = null } = options;
  const beforeVersion = installedVersion(profileNodeModules, name);
  // 来源那道门排在最前：非注册表来源连「线上最新是几」都不用问 —— 答案再新也不该装，
  // 而且这一条同时管着手动与自动两条路（自动更新永远不带 force，照样过不去）。
  const source = declaredSource(path.dirname(profileNodeModules), name);
  const gate = installAllowedFor(source);
  if (!gate.ok) {
    return {
      installed: false,
      skipped: true,
      beforeVersion,
      installedVersion: beforeVersion,
      source,
      command: null,
      output: '',
      failure: { code: gate.code, message: gate.message },
      check: null,
    };
  }
  const check = await checkForUpdate({ installedVersion: beforeVersion, source });
  // 「有没有新版」排在「有没有人在跑」**前面**：没东西可装的时候，拿一句「有对话在跑」挡住
  // 真正的答案（已经是最新）是误导 —— 2026-10-11 真机上就是这么被绊了一下。
  if (!force && !check.updateAvailable) {
    return {
      installed: false,
      skipped: true,
      beforeVersion,
      installedVersion: beforeVersion,
      source: check.source,
      command: null,
      output: '',
      failure: null,
      check,
    };
  }
  if (!force) {
    const running = runningAgentIds(agents);
    if (running.length > 0) {
      return {
        installed: false,
        skipped: false,
        beforeVersion,
        installedVersion: beforeVersion,
        source: check.source,
        command: null,
        output: '',
        runningAgents: running,
        retryable: true,
        check,
        failure: {
          code: 'AGENTS_RUNNING',
          message:
            `有 ${running.length} 个 agent 正在运行（${running.slice(0, 4).join(', ')}）。` +
            '装新版会就地替换插件文件，正在干活的对话可能读到半个包；等它完成（或先取消）再更新。' +
            '确定要现在装的话，点面板上的「强制更新」。',
        },
      };
    }
  }
  const result = await installLatest({ ...options, version: check.latestVersion });
  return { ...result, check };
}

module.exports = {
  installLatest,
  installLatestIfNeeded,
  installedVersion,
  declaredSource,
  toolSearchDirs,
  resolveExecutable,
  normalizeInvocation,
  runningAgentIds,
  DEFAULT_NAME,
  INSTALL_TIMEOUT_MS,
  OUTPUT_TAIL,
};
