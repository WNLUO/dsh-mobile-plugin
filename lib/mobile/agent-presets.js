'use strict';

/**
 * 移动端「Agent 预设管理」API：把桌面端设置页的预设管理分区补齐到手机上。
 *
 * 手机端只保留管理分区（app 的 PresetManager）：桌面那边设置里的一行与新建会话芯片已下线，
 * 手机一律吃宿主默认档。三条路由都只转发宿主的 agentPreset 域：read / copy / remove。
 *
 * 语义按宿主原文透传：copy 是整份复制，标识符成为目录名且事后无法更改；remove 只对 user
 * 预设有效（随附预设回 agent-preset-read-only）。宿主的失败对象是 code + details，按 code
 * 说中文，原文留在 details.hostMessage。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
// apiProxy 的回执信封拆解在 lib/mobile/envelope.js（唯一实现）。
const { unwrap } = require('./envelope.js');
const { callAgentPresets } = require('./rpc.js');

const PRESET_ID_MAX_CHARS = 64;          // 宿主的目录名上限远大于此，这里只是防呆
const PRESET_NAME_MAX_CHARS = 200;       // 显示名上限
const PRESET_BODY_MAX_CHARS = 256 * 1024; // 预设正文（YAML + 文档）字符数兜底
const PRESET_MAX_BODY = 64 * 1024;       // 请求体字节上限：三个接口都只送几个小字段

/**
 * 宿主 id 规则：`[a-z0-9][a-z0-9-]*`。
 * 桌面端的复制对话框复刻了同一条（dsh-client-ui-agent-preset 的 id 校验），宿主会再校验一次。
 */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 宿主失败码 → HTTP 状态；没见过的码一律 400，不假装成功。 */
function statusOf(code) {
  if (code === 'agent-preset-not-found') return 404;
  if (code === 'agent-preset-read-only') return 403;
  if (code === 'agent-preset-locked') return 409;
  return 400;
}

/** 宿主失败码 → 中文一句话。 */
function presetMessage(code, error) {
  if (code === 'agent-preset-not-found') return '这台宿主没有这个 Agent 预设';
  if (code === 'agent-preset-read-only') return '随附预设是安装目录的一部分，不能删除';
  if (code === 'agent-preset-invalid') return '预设标识不合法，或者这个标识已经被占用';
  if (code === 'agent-preset-locked') return '会话已经开跑，Agent 预设固定为开始时的那一档';
  if (code === 'bad-request') return 'Agent 预设请求不合法';
  const message = error && typeof error.message === 'string' ? error.message : '';
  return message || 'Agent 预设请求失败';
}

/** 失败回执：中文 message 在外，宿主原文与 details 原样留在里面。 */
function failure(error) {
  const code = error && typeof error.code === 'string' && error.code ? error.code : 'internal';
  const details = error && error.details && typeof error.details === 'object' ? error.details : undefined;
  const hostMessage = error && typeof error.message === 'string' && error.message ? error.message : undefined;
  return {
    code,
    message: presetMessage(code, error),
    ...(details || hostMessage ? { details: { ...(details || {}), ...(hostMessage ? { hostMessage } : {}) } } : {}),
  };
}

/**
 * 收窄客户端给的预设标识。
 * @param raw 请求体里的字段。
 * @returns { value } 或 { problem }（problem 是给用户看的中文）。
 */
function normalizeId(raw) {
  if (typeof raw !== 'string') return { problem: '需要预设标识' };
  const value = raw.trim();
  if (!value) return { problem: '需要预设标识' };
  if (value.length > PRESET_ID_MAX_CHARS) return { problem: `预设标识最长 ${PRESET_ID_MAX_CHARS} 个字符` };
  if (!PRESET_ID_RE.test(value)) return { problem: '预设标识只能用小写字母、数字和连字符，且以字母或数字开头' };
  return { value };
}

/** 显示名可有可无；给了就收窄，别把 undefined / 数字塞给宿主。 */
function normalizeName(raw) {
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'string') return { value: undefined };
  const value = raw.trim();
  if (!value) return { value: undefined };
  if (value.length > PRESET_NAME_MAX_CHARS) return { problem: `名称最长 ${PRESET_NAME_MAX_CHARS} 个字符` };
  return { value };
}

/** 读回执里的正文与元数据：缺字段就按缺处理，不编造。 */
function normalizeRead(value, fallbackId) {
  const id = value && typeof value.agentPreset === 'string' && value.agentPreset ? value.agentPreset : fallbackId;
  const content = value && typeof value.content === 'string' ? value.content : '';
  return {
    agentPreset: id,
    trust: value && value.trust === 'user' ? 'user' : 'system',
    content: content.length > PRESET_BODY_MAX_CHARS ? content.slice(0, PRESET_BODY_MAX_CHARS) : content,
    ...(value && typeof value.name === 'string' && value.name ? { name: value.name } : {}),
    ...(value && typeof value.description === 'string' && value.description ? { description: value.description } : {}),
  };
}

/**
 * POST /api/mobile/v1/agent-presets/read（token）{ agentPreset } → { ok, agentPreset, trust, content, name?, description? }
 * 桌面端「查看」：随附预设的正文是副本据以出发的已知良好组装，能读到它正是意义所在。
 */
async function handleAgentPresetRead(ctx, req, res) {
  const body = await readJsonBody(req, PRESET_MAX_BODY);
  const id = normalizeId(body && body.agentPreset);
  if (!id.value) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: id.problem } });
  const { value, error } = unwrap(await callAgentPresets(ctx, 'read', { agentPreset: id.value }));
  if (error) return sendJson(res, statusOf(error.code), { ok: false, error: failure(error) });
  sendJson(res, 200, { ok: true, ...normalizeRead(value, id.value) });
}

/**
 * POST /api/mobile/v1/agent-presets/copy（token）{ from, agentPreset, name? } → { ok, agentPreset }
 * 桌面端「复制预设」：整份复制到本机，标识符即目录名、事后无法更改，所以当场取好。
 */
async function handleAgentPresetCopy(ctx, req, res) {
  const body = await readJsonBody(req, PRESET_MAX_BODY);
  const from = normalizeId(body && body.from);
  if (!from.value) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要被复制的预设标识 from' } });
  }
  const id = normalizeId(body && body.agentPreset);
  if (!id.value) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: id.problem } });
  const name = normalizeName(body && body.name);
  if (name.problem) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: name.problem } });
  const payload = { from: from.value, agentPreset: id.value, ...(name.value ? { name: name.value } : {}) };
  const { value, error } = unwrap(await callAgentPresets(ctx, 'copy', payload));
  if (error) return sendJson(res, statusOf(error.code), { ok: false, error: failure(error) });
  const copied = value && typeof value.agentPreset === 'string' && value.agentPreset ? value.agentPreset : id.value;
  sendJson(res, 200, { ok: true, agentPreset: copied });
}

/**
 * POST /api/mobile/v1/agent-presets/remove（token）{ agentPreset } → { ok, agentPreset }
 * 只对 user 预设有效：随附预设是安装目录的一部分，宿主回 agent-preset-read-only。
 * 已在其上运行的会话不受影响，只是新会话不能再选它（宿主不改写既有会话）。
 */
async function handleAgentPresetRemove(ctx, req, res) {
  const body = await readJsonBody(req, PRESET_MAX_BODY);
  const id = normalizeId(body && body.agentPreset);
  if (!id.value) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: id.problem } });
  const { error } = unwrap(await callAgentPresets(ctx, 'remove', { agentPreset: id.value }));
  if (error) return sendJson(res, statusOf(error.code), { ok: false, error: failure(error) });
  sendJson(res, 200, { ok: true, agentPreset: id.value });
}

module.exports = {
  handleAgentPresetRead,
  handleAgentPresetCopy,
  handleAgentPresetRemove,
  // 下面这些是给守卫测试直接驱动的纯函数（与 references.js 同做法）
  normalizeId,
  normalizeName,
  normalizeRead,
  failure,
  unwrap,
  statusOf,
  presetMessage,
  PRESET_ID_RE,
  PRESET_ID_MAX_CHARS,
  PRESET_NAME_MAX_CHARS,
  PRESET_BODY_MAX_CHARS,
};
