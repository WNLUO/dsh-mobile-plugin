'use strict';

/**
 * 自己装新版：在 profile 里跑一次它自己的包管理器，把本插件换到指定版本。
 *
 * 不借道 DSH 插件市场：更新分「查」（update-registry）和「装」，装该由插件自己完成，不该因为
 * 另一个插件没装、太老或坏了就整个失效。
 *
 * 不自己实现包管理，只驱动它：profile 的 pnpm-workspace.yaml 已经写好 node-linker、peer 等
 * 关键设置，这里只「cd 到 profile 跑一句 pnpm add <包名>@<版本>」，不传布局类开关。必要的
 * 开关有两层：auto-install-peers=false（peer 是运行时注入的，npm 上没有）、minimum-release-age=0
 * （2026-10-26 用户要求一检测到新版就立刻装，不等「新发布先晾一会儿」；那道策略查的是整份
 * lockfile，别的插件刚发也会连累我们），再加上 CI=1（无终端）。命令行带一份、环境变量再带一份：
 * pnpm 12 的原生 CLI 会静默忽略这两个 --config 参数，环境变量那一份还认。
 *
 * 装完要**登记**：这个版本是被我们绕过晾置期装进去的，不写进 profile 的 minimumReleaseAgeExclude，
 * 它就会留在 lockfile 里，之后 pnpm 校验整份 lockfile 时把这台机器上所有安装都拒掉
 * （官方桌面端不替用户临时放行，只能干等 24 小时）。
 *
 * 包管理器优先用宿主发布的那个（profile 是宿主自带 pnpm 装的，PATH 上版本不同会
 * ERR_PNPM_UNEXPECTED_STORE），找不到再退回 PATH。装之前先看有没有 agent 在跑；force 与 auto
 * 都跳过这道闸（2026-10-26 用户要求自动更新一检测到新版就立刻装，与面板上那颗「强制更新」
 * 同一个口径），两者的区别只剩「没新版时装不装」。顺序上先答「有没有新版」，没东西可装时
 * 不该拿「有对话在跑」挡在前面。
 *
 * 宿主环境对不上时先修一次再重试：node_modules 是旧版 pnpm 建的（两个 hoist 相关的
 * ERR_PNPM_*_DIFF）就重建依赖树；记录的 store 和现在解析的不是同一个（ERR_PNPM_UNEXPECTED_STORE）
 * 就把记录里的那个 store 写回 profile 的 storeDir。两种都只修一次，修不了就如实失败 —— 这类
 * 现场不修的话，这台机器之后每一次更新都会撞同一堵墙。
 *
 * 只动 profile 的依赖树；找不到包管理器就如实失败；装完以盘上版本号为准，退出码 0 不算装上。
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

/** 依赖树是旧版 pnpm 建的：这两种报错都只说明「要重建」，不是这一版有问题。 */
const HOIST_DIFF = /ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF|ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF/;

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

/**
 * 每次调 pnpm 都带上的那两格策略开关，**环境变量这一份不是备份，是另一半**。
 *
 * pnpm 11 两种写法都认；pnpm 12 的原生 CLI 会静默忽略部分 `--config.*`（市场在 #600 上实测
 * 过，一次装失败一次白等），但同一个键走 `PNPM_CONFIG_*` 它照读。命令行与环境变量各带一份，
 * 换哪个大版本都不用重新猜。
 */
const POLICY_ENV = {
  PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false',
  PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0',
};

/** 「配置里这个包用的是哪个注册表」缓存多久：查更新两分钟一轮，源不常换。 */
const REGISTRY_CACHE_MS = 5 * 60 * 1000;

/** profile 目录 → 上一次问到的注册表（问不到也记，省得每轮重跑一次包管理器）。 */
const registryCache = new Map();

/**
 * 从 `<pm> config get registry` 的输出里取地址。
 *
 * pnpm / npm 都只回一行地址；升级提示、警告可能在前面，所以从后往前找第一个 http(s) 行。
 */
function parseRegistryOutput(output) {
  const lines = String(output || '').split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^https?:\/\/\S+$/.test(lines[i])) return lines[i].replace(/\/+$/, '');
  }
  return null;
}

/**
 * 这台机器上 pnpm / npm 真正会用的注册表。
 *
 * 问的是包管理器自己（`config get registry`），不是我们读文件猜：registry 可能来自 profile 的
 * `.npmrc`、用户级 rc、pnpm-workspace.yaml 的 registries，还可以是环境变量改的 —— 只有它自己
 * 的解析链能给出同一个答案。查更新与真正安装因此走同一个源，不会「查得到、装不上」，也是
 * 镜像 / 私有源机器上自动更新还能自己动的前提。
 *
 * 拿不到（没有包管理器、命令超时、输出里没有地址）就回 null，调用方退回官方源：
 * 这条链上多一次探测不该把「检查更新」变成不可用。`DSHM_NPM_REGISTRY` 显式给了值时不探，
 * 那是给人排查 / 私有部署用的最高优先级。
 */
async function profileRegistry({
  profileNodeModules,
  packageManager = null,
  env = process.env,
  platform = process.platform,
  dirs = null,
  timeoutMs = 20000,
  cache = registryCache,
  now = Date.now,
} = {}) {
  // `DSHM_NPM_REGISTRY` 显式给了值就不探：那是给人排查 / 私有部署用的最高优先级，
  // 而且查更新那一半读的是进程环境，这里不能只看子进程那一份。
  const override = String(env.DSHM_NPM_REGISTRY || process.env.DSHM_NPM_REGISTRY || '').trim();
  if (!profileNodeModules || override !== '') return null;
  const profileDir = path.dirname(profileNodeModules);
  const hit = cache.get(profileDir);
  if (hit && now() - hit.at < REGISTRY_CACHE_MS) return hit.registry;
  const searchDirs = dirs ?? toolSearchDirs({ platform, env });
  const childEnv = spawnEnv(searchDirs, env);
  const hostInvocation = normalizeInvocation(packageManager);
  const candidates = [];
  if (hostInvocation) candidates.push({ command: hostInvocation.command, prefix: hostInvocation.args, extraEnv: hostInvocation.env });
  const pnpm = resolveExecutable('pnpm', searchDirs, { platform, env });
  if (pnpm) candidates.push({ command: pnpm, prefix: [], extraEnv: {} });
  const npm = resolveExecutable('npm', searchDirs, { platform, env });
  if (npm) candidates.push({ command: npm, prefix: [], extraEnv: {} });
  let registry = null;
  for (const candidate of candidates) {
    const result = await run(candidate.command, [...candidate.prefix, 'config', 'get', 'registry'], {
      cwd: profileDir,
      env: { ...childEnv, ...candidate.extraEnv },
      timeoutMs,
    });
    if (!result.ok) continue;
    registry = parseRegistryOutput(result.output);
    if (registry) break;
  }
  cache.set(profileDir, { at: now(), registry });
  return registry;
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
 * 把一条「这一版是我故意装的」写进 profile 的 `minimumReleaseAgeExclude`。
 *
 * 为什么非要写：我们是用一次性开关把 24 小时内的版本装进去的，那个开关只对那一条命令生效。
 * 这一版随后留在 lockfile 里，pnpm 11 在**任何** add / remove 之前都会拿当前策略校验整份
 * lockfile —— 官方桌面端不替用户临时放行，于是这台机器上所有插件安装都要干等到它满 24 小时，
 * 报错还会点名我们这个包。写进去就是把「我信任这一版」这件事落在配置里，撤销的代价只有一行。
 *
 * 规则跟市场那边一致：**同名只读第一条**（pnpm 的 #883），所以必须并进已有的那一行，
 * 不能另起一行；条目可以是 `name@v || name@v2`，也可能是带引号的。单行的 flow 写法
 * （`minimumReleaseAgeExclude: [a, b]`）不碰 —— 改坏了比不写更贵，而 pnpm 自己写出来的是块形式。
 *
 * 失败一律返回 false，不抛：登记是善后，不是更新本身，它出问题不该把装好的版本说成没装上。
 */
function recordReleaseAgeExclusion(profileDir, name, version) {
  const file = path.join(profileDir, 'pnpm-workspace.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // 没有 workspace 文件就什么都不做：替人发明一个会改掉 pnpm 认的 workspace 根。
    return false;
  }
  const lines = text.split('\n');
  const at = lines.findIndex(line => /^minimumReleaseAgeExclude\s*:/.test(line));
  if (at !== -1) {
    const inline = lines[at].replace(/^minimumReleaseAgeExclude\s*:/, '').trim();
    if (inline !== '' && !inline.startsWith('#')) return false;
    let end = at;
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s+-/.test(line)) {
        end = i;
        continue;
      }
      break;
    }
    for (let i = at + 1; i <= end; i += 1) {
      const match = /^(\s*-\s*)(.*)$/.exec(lines[i]);
      if (!match) continue;
      const entry = parseExcludeEntry(match[2]);
      if (entry === null || entry.name !== name) continue;
      if (entry.versions.includes(version)) return true;
      lines[i] = `${match[1]}${addVersionToEntry(match[2], version)}`;
      fs.writeFileSync(file, lines.join('\n'));
      return true;
    }
    let indent = '  ';
    for (let i = at + 1; i <= end; i += 1) {
      const match = /^(\s+)-/.exec(lines[i]);
      if (match) {
        indent = match[1];
        break;
      }
    }
    lines.splice(end + 1, 0, `${indent}- ${excludeScalar(name, version)}`);
    fs.writeFileSync(file, lines.join('\n'));
    return true;
  }
  const tail = text.replace(/\s*$/, '');
  fs.writeFileSync(file, `${tail}${tail ? '\n' : ''}minimumReleaseAgeExclude:\n  - ${excludeScalar(name, version)}\n`);
  return true;
}

/** 一条排除规则：包名 + 已列举的版本（拼在 ` || ` 后面）。看不懂就回 null，别猜。 */
function parseExcludeEntry(raw) {
  let body = String(raw || '').trim();
  if (body === '' || body.startsWith('#')) return null;
  const quote = /^(['"])(.*)\1\s*$/.exec(body);
  if (quote) {
    body = quote[2];
  } else {
    const hash = body.search(/\s#/);
    if (hash !== -1) body = body.slice(0, hash).trim();
  }
  const parts = body.split('||').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const at = parts[0].lastIndexOf('@');
  if (at <= 0) return null;
  return {
    name: parts[0].slice(0, at),
    versions: parts.map(part => part.slice(part.lastIndexOf('@') + 1)),
  };
}

/** 往一条规则后面追版本，引号与行尾注释原样保留。 */
function addVersionToEntry(raw, version) {
  const body = String(raw).trim();
  const quote = /^(['"])(.*)\1\s*$/.exec(body);
  if (quote) return `${quote[1]}${quote[2]} || ${version}${quote[1]}`;
  const hash = body.search(/\s#/);
  if (hash === -1) return `${body} || ${version}`;
  return `${body.slice(0, hash)} || ${version}${body.slice(hash)}`;
}

/** 写进 YAML 的一条新规则；`@scope/...` 这种以 `@` 开头的标量必须带引号。 */
function excludeScalar(name, version) {
  const value = `${name}@${version}`;
  return value.startsWith('@') ? `'${value}'` : value;
}

/**
 * pnpm 说「记录的 store 和现在解析的不是同一个」时，把记录里的那个写回 profile。
 *
 * 这是 pnpm 报错里给的持久修法（`store-dir` 只在命令行那一次有效，改不改写
 * `node_modules/.modules.yaml` 里的记录才是关键）。只加、不改：已经有 `storeDir` 就不动，
 * 那种情况不是我们该替人翻的。
 */
function ensureProfileStoreDir(profileDir, storeDir) {
  const file = path.join(profileDir, 'pnpm-workspace.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (/^storeDir\s*:/m.test(text)) return false;
  const quoted = /[\s#:'"]/.test(storeDir) ? JSON.stringify(storeDir) : storeDir;
  const tail = text.replace(/\s*$/, '');
  fs.writeFileSync(file, `${tail}${tail ? '\n' : ''}storeDir: ${quoted}\n`);
  return true;
}

/** `child` 是不是 `parent` 以内（用来确认报错里的 node_modules 真是这个 profile 的）。 */
function isInsideDir(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 宿主**发布出来的**包管理器调用方式（DSH 桌面版把它挂在 `profileContext.packageManager`
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
 * @param {() => any} [options.beforeInstall] 真正跑包管理器**之前**调一次（外壳用它把正在跑的
 *   那一代复制进回退目录）。包管理器一跑就把旧的 store 目录清掉了，晚一步没得复制。
 * @returns {Promise<{installed, skipped, beforeVersion, installedVersion, source, command,
 *   manager, healed, releaseAgeRecorded, output, failure}>}
 */
async function installLatest({
  profileNodeModules,
  version,
  name = DEFAULT_NAME,
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
  // 一律带上：自动更新是「一检测到就装」，手动点的那一下同样是「现在就要」，没理由先让这道
  // 策略挡一次、再靠失败重试绕过来。命令行与环境变量各带一份，pnpm 12 只认后者（见 POLICY_ENV）。
  const policyArgs = ['--config.auto-install-peers=false', '--config.minimum-release-age=0'];
  const args = picked.manager === 'pnpm'
    ? ['add', spec, ...policyArgs]
    : ['install', spec, '--no-audit', '--no-fund'];
  const command = [picked.manager, ...args].join(' ');
  onEvent({ phase: 'install-started', command, manager: picked.kind });

  const runManager = (extraArgs, baseArgs = args) => run(picked.command, [...picked.prefix, ...baseArgs, ...extraArgs], {
    cwd: profileDir,
    env: { ...childEnv, ...picked.env, ...(picked.manager === 'pnpm' ? POLICY_ENV : {}) },
    timeoutMs,
  });

  let result = await runManager([]);
  let output = result.output;
  /**
   * 宿主环境对不上：不是这个包有问题，是这台机器的依赖树跟当前 pnpm 对不上 —— 不修的话，
   * 之后每一次更新都会撞同一堵墙。修一次、重试一次；修不了就如实失败，下个 tick 再来。
   *
   * 两种现场各有各的修法，判据都在 pnpm 自己的报错里：
   *   ① 布局是两个大版本之前建的（PUBLIC_HOIST_PATTERN_DIFF / VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF）
   *      → 用现在这版 pnpm 重建依赖树；
   *   ② 记录的 store 与它现在解析的不是同一个（UNEXPECTED_STORE）→ 把**记录里的那个**写回
   *      profile 的 storeDir。只取报错点名、且确实存在于盘上的那个路径；记录本身就是旧盘 /
   *      不存在的路径时不动 —— 那是另一种坏法，写回去只会换一种失败。
   */
  let healed = null;
  if (!result.ok && picked.manager === 'pnpm') {
    if (HOIST_DIFF.test(output)) {
      const rebuild = await runManager([], ['install', '--no-frozen-lockfile', ...policyArgs]);
      if (rebuild.ok) {
        healed = 'rebuild';
        result = await runManager([]);
        output = `${output}\n--- node_modules 是旧版 pnpm 建的，已重建依赖树并重试 ---\n${result.output}`;
      } else {
        output = `${output}\n--- 试着重建依赖树，但也没成：${rebuild.output} ---`;
      }
    } else if (/ERR_PNPM_UNEXPECTED_STORE/.test(output)) {
      const linked = /currently linked from the store at "([^"]+)"/.exec(output)?.[1];
      const modules = /The dependencies at "([^"]+)"/.exec(output)?.[1];
      if (linked && modules && isInsideDir(profileDir, modules) && fs.existsSync(linked)
        && ensureProfileStoreDir(profileDir, linked)) {
        healed = 'store';
        result = await runManager([]);
        output = `${output}\n--- pnpm 记录的 store 与本机解析的不一致，已把记录里的那个写回 storeDir 并重试 ---\n${result.output}`;
      }
    }
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
      healed,
      releaseAgeRecorded: false,
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
  // 这一版是我们绕开晾置期装进去的，登记进排除清单，免得它反过来把别的安装挡 24 小时。
  const releaseAgeRecorded = changed ? recordReleaseAgeExclusion(profileDir, name, after) : false;
  return {
    installed: changed,
    skipped: false,
    beforeVersion,
    installedVersion: after,
    source: declaredSource(profileDir, name),
    command,
    manager: picked.kind,
    healed,
    releaseAgeRecorded,
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
 * 这道闸，而且不管有没有新版都装一遍。`auto`（宿主那一轮自动更新）跳过同一道闸，只是仍然
 * 「没新版就不动盘」。发布晾置期**不再是一个「哪一档才跳过」的问题**：装的时候一律跳过，
 * 装完把这一版登记进排除清单（见文件头），所以手动、强制、自动三条路的安装条件是一致的。
 *
 * 「查」用的是这台机器上 pnpm / npm 真正在用的那个注册表（`profileRegistry`），不是写死的
 * 官方源：镜像是通的、官方源连不上的机器，也要能自己发现新版。
 */
async function installLatestIfNeeded(options = {}) {
  const { profileNodeModules, force = false, auto = false, name = DEFAULT_NAME, agents = null } = options;
  const beforeVersion = installedVersion(profileNodeModules, name);
  // 来源那道门排在最前：非注册表来源连「线上最新是几」都不用问 —— 答案再新也不该装，
  // 而且这一条同时管着手动与自动两条路（`force` / `auto` 都过不去）。
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
  // 查与装用同一个源：问一次这台机器上 pnpm / npm 真正在用的注册表（问不到才退回官方源）。
  // 不这样做的话，镜像 / 私有源机器上会出现「检查更新说连不上、手动装却是通的」。
  const registry = await profileRegistry({
    profileNodeModules,
    packageManager: options.packageManager ?? null,
    env: options.env,
    platform: options.platform,
    dirs: options.dirs ?? null,
    cache: options.registryCache,
  });
  const check = await checkForUpdate({ installedVersion: beforeVersion, source, base: registry ?? undefined });
  // 「有没有新版」排在「有没有人在跑」**前面**：没东西可装的时候，拿一句「有对话在跑」挡住
  // 真正的答案（已经是最新）是误导。
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
  if (!force && !auto) {
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
  profileRegistry,
  recordReleaseAgeExclusion,
  ensureProfileStoreDir,
  parseRegistryOutput,
  DEFAULT_NAME,
  INSTALL_TIMEOUT_MS,
  OUTPUT_TAIL,
};
