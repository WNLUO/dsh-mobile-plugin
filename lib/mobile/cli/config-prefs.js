'use strict';

/**
 * 「这个 CLI 该按哪一套配置跑」—— 一台电脑每个 CLI 记一份。
 *
 * ACP 的配置是**会话级**的：`session/new` 之后才有 `configOptions`，`set_config_option` 只对那一条
 * 会话生效，每开一条新对话都回到 CLI 默认档。所以这里把用户定的那套按 `agentId` 存下来，新会话
 * 握手完、第一次发消息之前逐项套过去。只记用户显式选过的项、没选过的不猜；选项表缓存一份供没开
 * 会话时画，但写入仍按新会话校验；写不进去不算错。文件：`$DSH_HOME/storages/mobile-plugin/cli-config.json`。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../../shared/paths');

function storeFile() {
  return path.join(paths.dshHome(), 'storages', 'mobile-plugin', 'cli-config.json');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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
    // 写不进去只是下次开局回到 CLI 自己的默认，不影响这一条会话。
  }
}

/**
 * 把 ACP 的一项配置压成「够画一个下拉」的形状。
 *
 * ACP 的 `options` 有两种：扁平的一项一条，或者按组（`{group, name, options}`）。手机那边
 * 只认平铺的一行选项，所以这里摊平并保留 `description`（档位说明对「这一档到底放没放开」很
 * 关键，用户要靠它决定选哪个）。
 */
function choicesOf(option) {
  const raw = Array.isArray(option && option.options) ? option.options : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.options)) {
      for (const child of item.options) {
        if (child && child.value !== undefined) {
          out.push({
            value: String(child.value),
            name: text(child.name) || String(child.value),
            ...(text(child.description) ? { description: text(child.description) } : {}),
            ...(text(item.name) ? { group: text(item.name) } : {}),
          });
        }
      }
      continue;
    }
    if (item.value !== undefined) {
      out.push({
        value: String(item.value),
        name: text(item.name) || String(item.value),
        ...(text(item.description) ? { description: text(item.description) } : {}),
      });
    }
  }
  return out;
}

/**
 * 会话的整份配置项 → 配置页能直接画的那张表。
 *
 * `category` 原样带出去：手机靠它分组（权限档 / 模型 / 思考档位 / 其它），而它是 ACP 定的
 * 语义分类，不是我们猜的。
 */
function describe(configOptions) {
  const list = Array.isArray(configOptions) ? configOptions : [];
  const out = [];
  for (const option of list) {
    if (!option || typeof option.id !== 'string' || !option.id) continue;
    const choices = choicesOf(option);
    if (choices.length === 0) continue;
    out.push({
      id: option.id,
      name: text(option.name) || option.id,
      ...(text(option.category) ? { category: text(option.category) } : {}),
      ...(text(option.description) ? { description: text(option.description) } : {}),
      ...(option.currentValue !== undefined ? { currentValue: String(option.currentValue) } : {}),
      choices,
    });
  }
  return out;
}

/** 这个 CLI 记着的那一套：`{ values: {<configId>: <value>}, options: [...] }`。 */
function prefsOf(agentId) {
  const entry = load()[text(agentId)];
  const values = entry && entry.values && typeof entry.values === 'object' ? entry.values : {};
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    if (key && typeof value === 'string' && value) clean[key] = value;
  }
  return { values: clean, options: Array.isArray(entry && entry.options) ? entry.options : [] };
}

/** 记下「这个 CLI 的某一项该用哪个值」（值空 = 撤掉这一项，回到 CLI 自己的默认）。 */
function setValue(agentId, configId, value) {
  const agent = text(agentId);
  const id = text(configId);
  if (!agent || !id) return;
  const agents = load();
  const entry = agents[agent] && typeof agents[agent] === 'object' ? { ...agents[agent] } : {};
  const values = entry.values && typeof entry.values === 'object' ? { ...entry.values } : {};
  const clean = text(value);
  if (clean) values[id] = clean;
  else delete values[id];
  if (Object.keys(values).length) entry.values = values;
  else delete entry.values;
  if (entry.values || (Array.isArray(entry.options) && entry.options.length)) agents[agent] = entry;
  else delete agents[agent];
  save(agents);
}

/** 记下这个 CLI 的选项表（配置页在没开会话时也要能画出来）。 */
function rememberOptions(agentId, configOptions) {
  const agent = text(agentId);
  if (!agent) return;
  const options = describe(configOptions);
  const agents = load();
  if (options.length === 0) {
    // 一家 CLI 本来就不给配置项：把旧表清掉，别让配置页停在上一版 CLI 的样子。
    const entry = agents[agent];
    if (!entry || !Array.isArray(entry.options) || entry.options.length === 0) return;
    const next = { ...entry };
    delete next.options;
    if (next.values) agents[agent] = next;
    else delete agents[agent];
  } else {
    const entry = agents[agent] && typeof agents[agent] === 'object' ? { ...agents[agent] } : {};
    agents[agent] = { ...entry, options };
  }
  save(agents);
}

module.exports = { storeFile, describe, prefsOf, setValue, rememberOptions };
