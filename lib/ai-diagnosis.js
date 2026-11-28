// 2026-11-24：本机面板全局悬浮 AI 问诊按钮的取选项与建会话发首句，只走 localOnly 控制面。
// 2026-11-28：首句带上包内 dsh-mobile-kb 正文；桌面预设没登记这份技能，模型调不到。
'use strict';

/**
 * 本机面板的 AI 问诊入口（面板里那颗全局悬浮按钮用）。
 *
 * 只挂在 /api/relay/* 的 localOnly 路由上：工作区与模型目录都读这台电脑上宿主 apiProxy，
 * 会话也只经宿主建、宿主发。不收移动端 token，不碰 shell，不接受任意路径；对外形状在这里
 * 收敛成小对象，任一路 RPC 失败或回执形状异常都回 { ok:false, error }，不把异常抛给路由层。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { unwrap } = require('./mobile/envelope.js');
const { callSessions } = require('./mobile/rpc.js');

const KB_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'config', 'agent-presets', 'standard', 'skills', 'dsh-mobile-kb');

const MAX_WORKSPACES = 100;
const MAX_MODEL_GROUPS = 16;
const MAX_MODELS_PER_GROUP = 40;
const MAX_PROMPT_CHARS = 20000;
const MAX_OPTION_CHARS = 200;
const DEFAULT_WORKSPACE_DIR = 'default-workspace';

/** 抛出来的异常也归一成信封里那套 { code, message }，不另起一套错误形状。 */
function errorOf(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code) {
    return {
      code: error.code,
      message: typeof error.message === 'string' && error.message ? error.message : error.code,
    };
  }
  return { code: 'internal', message: String(error && error.message ? error.message : error) };
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message } };
}

/** 与 app/src/drawerGroups.ts 的 isDefaultWorkspace 同一判据：标题或路径末段是那个目录名。 */
function isDefaultWorkspace(item) {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (title === DEFAULT_WORKSPACE_DIR) return true;
  const raw = typeof item.path === 'string' ? item.path.trim().replace(/[/\\]+$/, '') : '';
  return raw.split(/[\\/]/).pop() === DEFAULT_WORKSPACE_DIR;
}

/** 工作区只透四格；没有 workspaceId 的条目也留着，面板用 path 兜底。 */
function normalizeWorkspace(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId.trim() : '',
    title: typeof item.title === 'string' ? item.title.trim() : '',
    path: typeof item.path === 'string' ? item.path.trim() : '',
    isDefault: isDefaultWorkspace(item),
  };
}

/** 与 host-settings.js 的 normalizeModelGroup 同款精简，这里只要 id / name 两格。 */
function normalizeModelGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const provider = typeof group.id === 'string' ? group.id.trim() : '';
  if (!provider) return null;
  const displayName = typeof group.name === 'string' && group.name.trim() ? group.name.trim() : provider;
  const models = (Array.isArray(group.models) ? group.models : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) return null;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
      return { id, name };
    })
    .filter(Boolean)
    .slice(0, MAX_MODELS_PER_GROUP);
  if (models.length === 0) return null;
  return { provider, displayName, models };
}

/** 全局默认模型：优先 defaultModel，老宿主只给 current；两格不齐就当没有。 */
function normalizeDefaultModel(value) {
  const raw = value.defaultModel && typeof value.defaultModel === 'object'
    ? value.defaultModel
    : (value.current && typeof value.current === 'object' ? value.current : null);
  if (!raw) return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  return provider && model ? { provider, model } : null;
}

/** GET 选项：宿主工作区清单 + 模型目录，任一路坏掉都如实回错误。 */
async function buildAiDiagnosisOptions(ctx) {
  try {
    const workspace = unwrap(await ctx.apiProxy.workspace.list({
      rpcId: 'panel', method: 'workspace.list', payload: {},
    }));
    if (workspace.error) return { ok: false, error: workspace.error };
    const items = Array.isArray(workspace.value) ? workspace.value
      : (workspace.value && Array.isArray(workspace.value.items) ? workspace.value.items : null);
    if (!items) {
      return {
        ok: false,
        error: { code: 'host-workspace-list-degraded', message: '宿主工作区清单形状异常：响应里没有 items 数组' },
      };
    }
    // 默认工作区排在前面（同 isDefault 的保持宿主原序），再截上限：默认项不该被 100 条上限截掉。
    const rows = items.map(normalizeWorkspace).filter(Boolean);
    const workspaces = [...rows.filter((row) => row.isDefault), ...rows.filter((row) => !row.isDefault)]
      .slice(0, MAX_WORKSPACES);

    const models = unwrap(await ctx.apiProxy.llm.models({
      rpcId: 'panel', method: 'llm.models', payload: {},
    }));
    if (models.error) return { ok: false, error: models.error };
    const value = models.value;
    if (!value || typeof value !== 'object' || !Array.isArray(value.groups)) {
      return {
        ok: false,
        error: { code: 'host-model-list-degraded', message: '宿主模型目录形状异常：响应里没有 groups 数组' },
      };
    }
    return {
      ok: true,
      workspaces,
      models: value.groups.map(normalizeModelGroup).filter(Boolean).slice(0, MAX_MODEL_GROUPS),
      defaultModel: normalizeDefaultModel(value),
    };
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
}

/** 可选字段：空串当没带，类型不对或超长回 null 让调用方拒绝。 */
function optionalText(body, key) {
  const raw = body && body[key];
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length <= MAX_OPTION_CHARS ? text : null;
}

/**
 * 发第一句失败时收掉刚建的会话（宿主侧的归档动词叫 workspace.archiveSession，
 * 见 lib/mobile/workspaces.js 与 host-bridge/endpoints.js；没有 session.archive 这个方法）。
 * 归档是尽力而为：它失败也不能盖掉本次发消息的原始错误。
 */
async function archiveQuietly(ctx, sessionId) {
  try {
    await ctx.apiProxy.workspace.archiveSession({
      rpcId: 'panel', method: 'workspace.archiveSession', payload: { sessionId },
    });
  } catch { /* 原始失败才是要报给面板的那一个 */ }
}

/**
 * 桌面 standard 预设没登记 dsh-mobile-kb，模型在问诊会话里调它会得到 unknown。
 * 把包里同一份正文随首句带进去，references 仍读同一个目录，不留第二份副本；
 * 文件读不到时退回原首句，不让问诊整体失败。
 */
function withKnowledgeBase(prompt, kbDir = KB_DIR) {
  let body;
  try {
    body = fs.readFileSync(path.join(kbDir, 'SKILL.md'), 'utf8');
  } catch {
    return prompt;
  }
  return `${prompt}\n\n下面是 dsh-mobile-kb 技能的正文（这条会话里技能工具调不到它，直接照这份做）。正文里 references/xxx 指 ${path.join(kbDir, 'references')}/xxx，需要时用读文件工具打开；按里面的分类和顺序排查，不要再说这项技能没装。\n\n${body}`;
}

/** POST 建会话 + 带模型发送第一句；成功回 sessionId，失败回错误且不抛。 */
async function launchAiDiagnosis(ctx, body) {
  try {
    const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      return badRequest(prompt.length > MAX_PROMPT_CHARS
        ? `prompt 不能超过 ${MAX_PROMPT_CHARS} 字符`
        : '需要非空的 prompt');
    }
    const workspaceId = optionalText(body, 'workspaceId');
    const provider = optionalText(body, 'provider');
    const model = optionalText(body, 'model');
    if (workspaceId === null || provider === null || model === null) {
      return badRequest(`workspaceId / provider / model 必须是不超过 ${MAX_OPTION_CHARS} 字符的字符串`);
    }

    const created = unwrap(await callSessions(ctx, 'create', { ...(workspaceId ? { workspaceId } : {}) }));
    if (created.error) return { ok: false, error: created.error };
    const sessionId = created.value && typeof created.value.sessionId === 'string' ? created.value.sessionId : '';
    if (!sessionId) return { ok: false, error: { code: 'internal', message: '新建会话未返回 sessionId' } };

    const payload = {
      sessionId,
      // 知识库是包内自带的内容，不是面板入参；20k 的入口上限只管上面校验过的 prompt。
      content: [{ type: 'text', text: withKnowledgeBase(prompt) }],
      // 宿主 session.prompt 支持本次发送直接带模型，省掉「先建再 select」两步。
      ...(provider && model ? { modelSelection: { provider, model } } : {}),
    };
    let sent;
    try {
      sent = unwrap(await callSessions(ctx, 'prompt', payload, 'panel-ai-diagnosis'));
    } catch (error) {
      await archiveQuietly(ctx, sessionId);
      return { ok: false, error: errorOf(error) };
    }
    if (sent.error) {
      await archiveQuietly(ctx, sessionId);
      return { ok: false, error: sent.error };
    }
    return { ok: true, sessionId };
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
}

export { buildAiDiagnosisOptions, launchAiDiagnosis, withKnowledgeBase };
