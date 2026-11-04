'use strict';

/**
 * CLI 的模型开关 —— 手机上「这个 CLI 里哪些模型要显示、哪些藏起来」的那本账。
 *
 * 为什么存在插件里而不是手机本地：ACP 的模型目录是**那台电脑上的 CLI 自己给的**，各家会不会
 * 「只列一部分」全看它自己，我们既不能替它删、也写不回它的配置。所以这一档只能当**展示层**
 * 的账来做：哪几个要显示由用户定，账存在电脑上，换一台手机看到的是同一份（`model-visibility`
 * 在 App 里存的是那份「按设备分桶的副本」，开机对一次源）。
 *
 * 与 App 那本 `model-visibility` 的关系：宿主这套模型目录（`/session/models`）本来就有「只影响
 * 本机显示」的开关，CLI 这边多了个「换手机也要一样」的要求，所以真值放这儿，App 那边只读。
 * 只记「被关掉的」：模型目录天天在长，记白名单会让新模型默认不出现。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../../shared/paths');

/** 文件：`$DSH_HOME/storages/mobile-plugin/cli-model-visibility.json`。 */
function storeFile() {
  return path.join(paths.dshHome(), 'storages', 'mobile-plugin', 'cli-model-visibility.json');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `{ agents: { <agentId>: { models: [modelId…], configs: [configId…] } } }`
 *
 * 两个桶：
 *   - `models`：被关掉的模型（目录里不出现）；
 *   - `configs`：被关掉的整组（一个 CLI 里可能有多组模型，opencode 的「Go 订阅」就是一组）。
 */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const agents = raw && typeof raw === 'object' ? raw.agents : null;
    return agents && typeof agents === 'object' ? agents : {};
  } catch {
    return {};
  }
}

function save(agents) {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify({ agents }, null, 0), 'utf8');
  } catch {
    // 写不进去只是这台电脑重启后开关回到全开，不影响这一次点击。
  }
}

/** 这个 CLI 被关掉的模型与整组：`{ models: string[], configs: string[] }`（没有就是空数组）。 */
function hiddenOf(agentId) {
  const entry = load()[text(agentId)];
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : []);
  return {
    models: list(entry && entry.models),
    configs: list(entry && entry.configs),
  };
}

/**
 * 改一个模型（或一整组）的开关。
 *
 * `kind`：
 *   - `'model'`：`id` 是模型 id（就是 ACP 那个 `value`）；
 *   - `'config'`：`id` 是一组的 id（模型 id 里斜杠前那一段）。
 *
 * `visible === true` 是把它从账里删掉 —— **账只记关掉的**，所以「打开」等于「不记」。
 */
function setVisible(agentId, kind, id, visible) {
  const agent = text(agentId);
  const target = text(id);
  if (!agent || !target) return;
  const agents = load();
  const entry = agents[agent] && typeof agents[agent] === 'object' ? { ...agents[agent] } : {};
  const bucket = kind === 'config' ? 'configs' : 'models';
  const current = new Set(Array.isArray(entry[bucket]) ? entry[bucket].filter((item) => typeof item === 'string' && item) : []);
  if (visible) current.delete(target);
  else current.add(target);
  if (current.size) entry[bucket] = [...current].sort();
  else delete entry[bucket];
  if (entry.models || entry.configs) agents[agent] = entry;
  else delete agents[agent];
  save(agents);
}

module.exports = { storeFile, hiddenOf, setVisible };
