'use strict';

/**
 * 「这条 CLI 上次用的是哪个模型」—— 一台电脑每个 CLI 记一份。
 *
 * 为什么要记：ACP 的模型是**会话级**配置（`session/new` 之后才有 `configOptions`，`set_config_option`
 * 只对那一条会话生效）。不记的话，每次从侧栏新建一条 CLI 对话都回到 CLI 自己的默认模型，用户
 * 每一轮都要在手机上重新选一次 —— 这在普通会话里是不存在的体验（宿主那边默认模型是设备级的）。
 *
 * 记账口径是 `agentId`（codex / claude / gemini / opencode …），不是会话 id：换一条对话、换一台
 * 手机、宿主重启之后，用户选过的仍然是那一个。
 *
 * 只记「配置项 id + 选中值」这一对，不记目录：模型清单每次由 CLI 自己给，我们记的只是「上次
 * 选的是哪一个」。那个值在新会话里不存在（CLI 升级换了模型名）时就当没记过 —— 悄悄退回默认，
 * 不去设一个它不认识的值。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../../shared/paths');

/** 文件：`$DSH_HOME/storages/mobile-plugin/cli-models.json`。 */
function storeFile() {
  return path.join(paths.dshHome(), 'storages', 'mobile-plugin', 'cli-models.json');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return raw && typeof raw === 'object' && raw.agents && typeof raw.agents === 'object' ? raw.agents : {};
  } catch {
    return {};
  }
}

function save(agents) {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify({ agents }, null, 0), 'utf8');
  } catch {
    // 写不进去只是下次要重新选一次，不影响这一次。
  }
}

/** 这个 CLI 上次选的模型：`{ configId, value }`，没记过就 null。 */
function preferredModel(agentId) {
  const entry = load()[text(agentId)];
  const configId = text(entry && entry.configId);
  const value = text(entry && entry.value);
  return configId && value ? { configId, value } : null;
}

/** 记下这个 CLI 这次选的模型（`value` 空 = 清掉）。 */
function rememberModel(agentId, configId, value) {
  const id = text(agentId);
  if (!id) return;
  const agents = load();
  const cleanConfig = text(configId);
  const cleanValue = text(value);
  if (!cleanConfig || !cleanValue) {
    delete agents[id];
  } else {
    agents[id] = { configId: cleanConfig, value: cleanValue };
  }
  save(agents);
}

module.exports = {
  storeFile,
  preferredModel,
  rememberModel,
};
