'use strict';

/**
 * 模型附加选项：模型之外还能调的几档（速度、输出详略……）。
 *
 * 宿主的模型目录只有「模型 + 推理等级」两层；别的档位是插件自己的偏好（例如 Codex
 * 订阅插件的 speedMode / outputVerbosity），桌面端由那个插件接管整个模型菜单自己画，
 * 所以宿主接口里根本没有这些行。这里把它们翻译成**数据**：App 收到几行就画几行，
 * 不认识任何具体插件。
 *
 * 一条来源 = 一个 provider + 它的设置命名空间 + 行描述。加一个插件就是加一条；没有
 * 来源时 `options` 为空，App 仍然只画模型和推理等级。读写都只经过宿主自己的 settings
 * 服务（describe / mutate），不碰插件私有接口；可写字段也仅限这张表里列出的那些。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { invalidateSessionModels } = require('./session-cache.js');

/** 行描述：id/title 给 App 画，field 是插件设置里的字段名。 */
const OPTION_SOURCES = [
  {
    provider: 'openai-codex',
    settingsNs: 'codex-subscription',
    rows: [
      {
        id: 'speed',
        title: '速度',
        field: 'speedMode',
        choices: [
          { id: 'standard', name: '标准', description: '标准速度' },
          { id: 'fast', name: '高速', description: '优先处理，消耗更多 Credits' },
          { id: 'ultrafast', name: 'Ultrafast', description: '账号目录提供时可用，消耗更快' },
        ],
      },
      {
        id: 'verbosity',
        title: '输出详略',
        field: 'outputVerbosity',
        choices: [
          { id: 'default', name: '模型默认', description: '使用官方模型目录推荐值' },
          { id: 'low', name: '简洁', description: '更短、更直接' },
          { id: 'medium', name: '均衡', description: '兼顾完整性与长度' },
          { id: 'high', name: '详细', description: '更充分的说明与结构' },
        ],
      },
    ],
  },
];

const MAX_ROWS = 12;
const MAX_CHOICES = 32;
/** 选项说明和模型描述一样，选择器里只画一行；正文没必要按 4KB 下发。 */
const MAX_CHOICE_DESCRIPTION = 200;

function sourceFor(provider) {
  return OPTION_SOURCES.find((source) => source.provider === provider);
}

/** 宿主 settings 里这个插件的命名空间视图；读不到（插件没装 / 没装 settings）返回 null。 */
async function describeNamespace(ctx, source) {
  let response;
  try {
    response = await ctx.apiProxy.settings.describe({
      rpcId: 'mobile',
      method: 'settings.describe',
      payload: {},
    });
  } catch {
    // 旧宿主的 apiProxy 未必有 settings 这一域：附加选项是锦上添花，别让它拖垮模型目录。
    return null;
  }
  const { value, error } = unwrap(response);
  if (error) return null;
  // 远程那层（SettingsDescribeValue）把命名空间放在 `namespaces` 里，只有宿主进程内的
  // settings.describe 才直接回数组 —— 两种都认，别只按其中一种写。
  const rows = Array.isArray(value)
    ? value
    : (value && Array.isArray(value.namespaces) ? value.namespaces : []);
  // 先按 profile 条目 id 认；条目 id 在别处被改过时，退回「这个命名空间里有我们认识的
  // 字段」——总比整个功能静默消失好。
  const namespace = rows.find((row) => row && row.ns === source.settingsNs)
    || rows.find((row) => row && row.value && typeof row.value === 'object'
      && source.rows.every((option) => Object.hasOwn(row.value, option.field)));
  if (!namespace || !namespace.value || typeof namespace.value !== 'object') return null;
  return namespace;
}

/** 这个 provider 的当前行；没有来源或读不到设置时返回空数组。 */
async function readModelOptions(ctx, provider) {
  const source = typeof provider === 'string' ? sourceFor(provider) : undefined;
  if (!source) return [];
  const namespace = await describeNamespace(ctx, source);
  if (!namespace) return [];
  const options = [];
  for (const row of source.rows) {
    const value = namespace.value[row.field];
    if (typeof value !== 'string' || !value) continue;
    options.push({
      id: row.id,
      title: row.title,
      value,
      choices: row.choices.map((choice) => ({ ...choice })),
    });
  }
  return options.slice(0, MAX_ROWS);
}

/**
 * 响应清洗，与 `safeModelsValue` 同一套路：宿主（以及那一层描述表）会随版本变，
 * 进 App 之前逐字段挑出来，宁可少一行也不把半截对象糊上去。
 */
function safeModelOptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row && typeof row.id === 'string' && typeof row.title === 'string' &&
      typeof row.value === 'string' && Array.isArray(row.choices))
    .slice(0, MAX_ROWS)
    .map((row) => ({
      id: row.id.slice(0, 256),
      title: row.title.slice(0, 512),
      value: row.value.slice(0, 256),
      choices: row.choices
        .filter((choice) => choice && typeof choice.id === 'string' && typeof choice.name === 'string')
        .slice(0, MAX_CHOICES)
        .map((choice) => ({
          id: choice.id.slice(0, 256),
          name: choice.name.slice(0, 512),
          ...(typeof choice.description === 'string' ? { description: choice.description.slice(0, MAX_CHOICE_DESCRIPTION) } : {}),
        })),
    }));
}

/**
 * 写一行。只认表里声明过的行与取值 —— 这是移动 API 上唯一一处写插件设置的入口，
 * 不开放任意 ns / 字段。
 */
async function writeModelOption(ctx, provider, optionId, value) {
  const source = sourceFor(provider);
  const row = source ? source.rows.find((candidate) => candidate.id === optionId) : undefined;
  if (!row) return { error: { code: 'bad-request', message: '未知的模型选项' } };
  if (!row.choices.some((choice) => choice.id === value)) {
    return { error: { code: 'bad-request', message: '未知的选项值' } };
  }
  const namespace = await describeNamespace(ctx, source);
  if (!namespace) return { error: { code: 'host-unavailable', message: `设置里没有 ${source.settingsNs} 的可写字段` } };
  let response;
  try {
    response = await ctx.apiProxy.settings.mutate({
      rpcId: 'mobile',
      method: 'settings.mutate',
      payload: {
        ns: source.settingsNs,
        ops: [{ op: 'set', path: [row.field], value }],
        ...(Number.isSafeInteger(namespace.revision) ? { expectedRevision: namespace.revision } : {}),
      },
    });
  } catch (error) {
    return { error: { code: 'host-call-failed', message: error instanceof Error ? error.message : String(error) } };
  }
  const { error } = unwrap(response);
  if (error) return { error };
  return { value: true };
}

/**
 * POST /api/mobile/v1/session/model-option（token）{sessionId, provider, optionId, value}
 *
 * 写完作废这条会话的目录缓存，否则手机上会拿着旧值直到 20 秒 TTL 到期
 * （与切模型那条同样的坑）。
 */
async function handleModelOption(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId ||
      typeof body.provider !== 'string' || !body.provider ||
      typeof body.optionId !== 'string' || !body.optionId ||
      typeof body.value !== 'string' || !body.value) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, provider, optionId, value }' } });
  }
  const result = await writeModelOption(ctx, body.provider, body.optionId, body.value);
  if (result.error) return sendJson(res, 400, { ok: false, error: result.error });
  invalidateSessionModels(ctx, req, body.sessionId);
  sendJson(res, 200, { ok: true });
}

module.exports = { OPTION_SOURCES, readModelOptions, safeModelOptions, writeModelOption, handleModelOption };
