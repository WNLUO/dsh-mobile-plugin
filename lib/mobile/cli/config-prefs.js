'use strict';

/**
 * 「这个 CLI 该按哪一套配置跑」—— 一台电脑每个 CLI 记一份。
 *
 * 为什么要有它（用户 2026-11-04：「每次对话都要先去改权限再去发对话，习惯根本调不过来」）：
 * ACP 的配置是**会话级**的 —— `session/new` 之后才有 `configOptions`，`set_config_option` 只对
 * 那一条会话生效。于是每开一条新对话都回到 CLI 自己的默认档：权限松到「完全放开」、或者紧到
 * 「每动一下都弹审批」，两种都得人再调一次。而调不了的时候最难受：AI 正在跑、审批卡挂着，
 * 这一轮没结束就改不动配置 —— 用户说的「得等这一轮结束才能去调权限」正是这个。
 *
 * 所以这里做的是「**记住，然后开局就套上**」：用户在配置页里定的那一套（权限档 / 模型 /
 * 思考档位 / 其它会话级下拉）存在这台电脑上，按 `agentId` 记；新建会话握手完、第一次发消息之前
 * 逐项套过去。ACP 没有「一次设置管所有会话」的开关，但对用户来说效果就是全局的。
 *
 * 三条口径：
 *
 *   1. **只记用户显式选过的项**（`values`）。没选过的不记，新会话就让 CLI 用它自己的默认 ——
 *      替用户猜一个档位，等于悄悄改了它的行为。
 *   2. **选项表也记一份**（`options`）。配置页要在**没开会话**的时候就能画出「权限档有哪几个」，
 *      而那是 CLI 握手之后才给的东西；不缓存就只能等开一条对话才看得见。缓存只用于显示，
 *      真正写的时候仍然按新会话自己给的那张表校验（CLI 升级换了档位名这类情况就不会写错）。
 *   3. **写不进去不算错**。新会话里那一项不存在（换了名字 / 这一版没这个选项）就跳过它，
 *      停在 CLI 自己的默认上，别让一条过期的偏好把整条会话建不起来。
 *
 * 文件：`$DSH_HOME/storages/mobile-plugin/cli-config.json`。
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
