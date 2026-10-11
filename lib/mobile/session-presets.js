'use strict';

/**
 * Agent 预设目录（宿主 agentPreset.list）。
 *
 * 宿主没有 roster 时返回空列表而不是错误（`presets: []`），这与 search 的「未开启
 * 就报错」不同——空列表是合法的「没得选」，两种语义要分得清，否则 App 会把「没配」
 * 报成「挂了」。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callAgentPresets } = require('./rpc.js');

/**
 * GET /api/mobile/v1/agent-presets（token）→ { ok, presets, authorable, hasDocument }
 *
 * 透传宿主 agentPreset.list。宿主返回 `presets: [{ id, trust, isDefault, name?,
 * description?, broken? }]`（name/description 缺省时表示该预设没写显示名，桌面端
 * 也只用 id 兜底）。桌面端的会话头标签、设置行、hero 芯片都读这份数据；移动端只有预设
 * 管理页（`PresetManager`）读它——输入区的预设芯片已下线，别再按「输入区有芯片」改这里。
 *
 * 注意：宿主没有 roster 时返回空列表而不是错误（presets: []），这与 search 的
 * 「未开启就报错」不同 —— 空列表是合法的「没得选」。
 */
async function handleAgentPresets(ctx, req, res) {
  const { value, error } = unwrap(await callAgentPresets(ctx, 'list', {}));
  if (error) return sendJson(res, 400, { ok: false, error });
  const raw = value && Array.isArray(value.presets) ? value.presets : [];
  const presets = [];
  for (const item of raw) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    presets.push({
      id: item.id,
      trust: typeof item.trust === 'string' ? item.trust : 'system',
      isDefault: item.isDefault === true,
      ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
      ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
      ...(item.broken === true ? { broken: true } : {}),
    });
  }
  sendJson(res, 200, {
    ok: true,
    presets,
    // 与条目内的 isDefault / broken 同口径：宿主只该给布尔，非布尔一律当 false，
    // 不让 'yes' / 1 这种值被 App 当成「可以自己写预设」。
    authorable: value != null && value.authorable === true,
    hasDocument: value != null && value.hasDocument === true,
  });
}

module.exports = { handleAgentPresets };
