'use strict';

/**
 * 官方 ACP 注册表：手机上那份「能起哪些 CLI」不再写死。
 *
 * 为什么改成读注册表：逐家适配是件永远追不完的活，而 ACP 生态已经把这件事做成了一份清单 ——
 * `cdn.agentclientprotocol.com/registry/v1/latest/registry.json` 里每个 agent 都写清了起法
 * （包名、参数、分发方式、维护方、图标），由各家和 Zed 一起维护。我们只需要读它，把它们当成
 * 同一种东西交给 ACP 连接层；新 CLI 上线不需要我们发版。
 *
 * **只收 `distribution.npx` 那一档**：能 `npx` 拉起来的是纯 JS 包，起法与现有桥包完全一样；
 * `binary` 那一档要下载可执行文件、按平台选架构、还要校验，是另一件事，这轮不做 —— 于是
 * 注册表里有、但只有二进制分发的（Cursor / Kiro / Amp …）在清单里不出现，而不是出现一个点了
 * 会失败的行。
 *
 * 三级兜底，任何一级拿到就收手：
 *   1. 内存（这个进程问过一次就不再问）；
 *   2. 盘上缓存（`$DSH_HOME/storages/mobile-plugin/acp-registry.json`，一天内算新鲜）；
 *   3. 联网拉一次；拉不到就用过期缓存；连缓存都没有就退回 `agents.js` 的内置四家。
 *
 * 联网失败**不抛也不报错**：手机要的是「能起哪些」，离线时给出上次那份（或内置那份）就够了，
 * 为一份清单弹一张红卡不值得。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../../shared/paths');

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/** 缓存多久算新鲜：一天。注册表按小时自动更新版本号，一天一拉足够跟上。 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 拉取超时：清单是几十 KB 的一发，慢到这个份上就当作拉不到。 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 拉失败之后多久再试。
 *
 * 失败也记一份（用的是过期缓存或内置表），但只记五分钟：断网时不该每问一次清单就干等八秒；
 * 网络刚恢复时也不该让人等一天才看见新 CLI。
 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

/** 内存里那一份（含拉取成败的结论，失败也记，免得每次问都再等 8 秒）。 */
let memory = null;

function cacheFile() {
  return path.join(paths.dshHome(), 'storages', 'mobile-plugin', 'acp-registry.json');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 一条注册表条目 → 我们的适配器形状。
 *
 * 只认 npx 那一档：`package` 可能带版本（注册表就是这么发的，`@agentclientprotocol/codex-acp@2.5.0`），
 * 原样交给 `npx -y`，版本由注册表钉住 —— 我们不去猜「最新版」。
 */
function adapterOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = text(entry.id);
  const pkg = text(entry.distribution && entry.distribution.npx && entry.distribution.npx.package);
  if (!id || !pkg) return null;
  const args = Array.isArray(entry.distribution.npx.args)
    ? entry.distribution.npx.args.filter((arg) => typeof arg === 'string')
    : [];
  return {
    id,
    label: text(entry.name) || id,
    transport: 'npx',
    package: pkg,
    ...(args.length ? { args } : {}),
    // 图标地址原样留着：`cli/icons.js` 用它在本地缓存一份 SVG，App 按 id 取（见那边文件头）。
    ...(text(entry.icon) ? { icon: text(entry.icon) } : {}),
    ...(text(entry.description) ? { description: text(entry.description) } : {}),
  };
}

/**
 * 注册表 JSON → 适配器数组（去重、丢掉没有 npx 分发的）。
 */
function adaptersOf(body) {
  const agents = body && Array.isArray(body.agents) ? body.agents : [];
  const seen = new Set();
  const out = [];
  for (const entry of agents) {
    const adapter = adapterOf(entry);
    if (!adapter || seen.has(adapter.id)) continue;
    seen.add(adapter.id);
    out.push(adapter);
  }
  return out;
}

/**
 * 内置表与注册表合一份清单：**内置的那几条优先**，注册表只补它没有的。
 *
 * 为什么不是「注册表整份替换内置」：注册表只收 npx 分发，而 opencode 在那里只有二进制分发
 * （会整条被过滤掉），gemini / codex / claude 又各有一个 `-acp` 后缀的桥包条目 —— 直接替换
 * 的结果是「opencode 从清单里消失」，接着建会话那一步回「不认识这个 CLI」，而用起来只是
 * 「列表里少了几个、点了报错」。所以两边并起来，同一家只留一条：
 *
 *   1. id 完全相同 → 留内置（`gemini`）；
 *   2. id 去掉 `-acp` 后缀后相同 → 留内置（`codex-acp` / `claude-acp` 对 `codex` / `claude`）；
 *   3. 包名相同 → 留内置（同一条适配器换个名字而已）。
 *
 * 内置那几条用的是本机已经装好的 CLI（`gemini --acp` / `opencode acp`），比去 `npx` 拉一份
 * 新包快得多，所以「优先内置」不只是去重策略，也是更短的那条路。
 */
function mergeWithBuiltin(builtin, fromRegistry) {
  const kept = Array.isArray(builtin) ? builtin.filter(Boolean).slice() : [];
  const ids = new Set(kept.map((agent) => agent.id));
  const bareIds = new Set(kept.map((agent) => String(agent.id).replace(/-acp$/, '')));
  const packages = new Set(kept.map((agent) => agent.package).filter(Boolean));
  for (const agent of Array.isArray(fromRegistry) ? fromRegistry : []) {
    if (!agent || !agent.id) continue;
    if (ids.has(agent.id)) continue;
    if (bareIds.has(String(agent.id).replace(/-acp$/, ''))) continue;
    if (agent.package && packages.has(agent.package)) continue;
    ids.add(agent.id);
    kept.push(agent);
  }
  return kept;
}


function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const agents = Array.isArray(raw && raw.agents) ? raw.agents.filter((item) => item && typeof item.id === 'string') : [];
    if (!agents.length) return null;
    return { fetchedAt: Number(raw.fetchedAt) || 0, agents };
  } catch {
    return null;
  }
}

function writeCache(agents) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), agents }), 'utf8');
  } catch {
    // 写不进去只是下次还要联网拉一遍，不影响这次。
  }
}

async function fetchRegistry() {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const agents = adaptersOf(await res.json());
    return agents.length ? agents : null;
  } catch {
    return null;
  }
}

/**
 * 这一次该用哪份清单。`builtin` 是调用方给的内置表（`agents.js` 那四家）——
 * 它**永远在清单里**，注册表只补它没有的（理由见 `mergeWithBuiltin`）。
 */
async function listRegistryAgents(builtin) {
  const now = Date.now();
  const base = Array.isArray(builtin) ? builtin : [];
  if (memory && now - memory.at < (memory.degraded ? FAILURE_TTL_MS : TTL_MS)) {
    return mergeWithBuiltin(base, memory.agents);
  }
  const cached = readCache();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    memory = { at: cached.fetchedAt, agents: cached.agents };
    return mergeWithBuiltin(base, cached.agents);
  }
  const fetched = await fetchRegistry();
  if (fetched) {
    writeCache(fetched);
    memory = { at: now, agents: fetched };
    return mergeWithBuiltin(base, fetched);
  }
  // 拉不到：过期缓存也比只有内置那四家强，先用它；都没有就只剩内置。
  const fallback = cached && cached.agents.length ? cached.agents : [];
  memory = { at: now, agents: fallback, degraded: true };
  return mergeWithBuiltin(base, fallback);
}

/** 测试用：清掉内存那一份（盘上缓存照旧）。 */
function resetRegistryMemory() {
  memory = null;
}

module.exports = {
  REGISTRY_URL,
  TTL_MS,
  FAILURE_TTL_MS,
  listRegistryAgents,
  adaptersOf,
  adapterOf,
  mergeWithBuiltin,
  resetRegistryMemory,
  cacheFile,
};
