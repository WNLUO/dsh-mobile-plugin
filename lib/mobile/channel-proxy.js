// 2026-11-26：手机够不着的渠道，由电脑代发模型请求（只转发模型调用，会话仍在手机上）。
// 2026-11-26：自建渠道查不到时退回 DSH 自己的模型服务，当前 DSH 渠道也能经电脑代发。
'use strict';

/**
 * `POST /api/mobile/v1/channels/chat`：手机借这台电脑的手，向一条渠道发一次流式对话。
 *
 * 为什么需要：手机上的本机 Agent 是自己直连渠道的，但渠道地址可能是 `127.0.0.1`（Ollama、
 * one-api 跑在这台电脑上）、或者只在内网可达 —— 手机拨不到。这样一条渠道不该变成「用不了」，
 * 让电脑转一手就通了。
 *
 * 两条转发路，共用同一个出口：
 *  1. 自建渠道（`llm-pi-ai` 的 providers）：按 id 取电脑自己的地址与 Key，直接打它的
 *     OpenAI 兼容端点，上游的 `data:` 原样成帧回手机；
 *  2. 其它渠道（DSH 当前在用的那种）：电脑上没有可搬的地址与 Key，改请 DSH 自己的模型服务
 *     按同一 id 跑这一次对话 —— 它认识宿主 / 插件注册的所有渠道，凭据也用电脑那份。
 *     这一路把 DSH 的增量块翻成 OpenAI chunk，手机解析的代码一行不用改。
 *
 * 边界：**只转发模型调用这一层**。会话记录、手机侧的工具循环仍在手机上，这条路由不建会话、
 * 不写任何日志、不碰工作区。请求体只收 OpenAI 兼容对话的四样东西（messages / model /
 * tools / 生成参数），渠道的地址与 Key 一律用宿主自己那一份，手机给什么 id 就查什么 id。
 *
 * 回包是 SSE：协议 v2 的设备逐帧加密，与 `/session/stream` 同一套封装（见 `createFrameSealer`）。
 * 上游中途失败时补一帧 `{ dshError: { code } }`，手机据此把它翻成界面上的失败原因。
 */

const { randomUUID } = require('node:crypto');
const { readJsonBody } = require('../shared/http-util');
const { writeSse } = require('../shared/sse-write.js');
const { customChannelWithKey } = require('./channels.js');
const { createFrameSealer } = require('./stream.js');

/** 请求体上限：一条带图带文件的对话也远小于这个数。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 上游单次连接的超时：模型第一个字常常要等十几秒，给足。 */
const UPSTREAM_IDLE_MS = 120_000;

/** 渠道地址 → chat/completions 地址。规则与桌面端、手机端同一份：写了 `/v1` 就不再补。 */
function chatCompletionUrlOf(baseUrl) {
  const root = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
  if (root === '') return '';
  return root.endsWith('/v1') ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
}

/**
 * 手机报上来的对话原样交给渠道：只放行 OpenAI 兼容的那几个字段，其余一律不转发。
 *
 * 不把整个 body 透传是有意的：透传等于让手机决定这次请求的地址、Key、流开关，
 * 那就不再是「借电脑的手发一次对话」了。
 */
function upstreamBodyOf(body, model) {
  const pick = (key) => (body && typeof body === 'object' ? body[key] : undefined);
  const messages = pick('messages');
  const out = {
    model,
    stream: true,
    messages: Array.isArray(messages) ? messages : [],
  };
  const tools = pick('tools');
  if (Array.isArray(tools) && tools.length > 0) {
    out.tools = tools;
    out.tool_choice = pick('toolChoice') === 'none' ? 'none' : 'auto';
  }
  const maxTokens = Number(pick('maxTokens'));
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.trunc(maxTokens);
  const temperature = Number(pick('temperature'));
  if (Number.isFinite(temperature) && temperature >= 0) out.temperature = temperature;
  return out;
}

/** 一条 SSE 记录里的 `data:` 正文；不是 data 行就回 null（注释行、event 行都不算）。 */
function dataOfRecord(record) {
  const lines = record.split('\n');
  const parts = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    parts.push(line.slice(5).replace(/^ /, ''));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * 把上游的字节流切成一条条 SSE 记录（空行分隔），逐条交出去。
 *
 * 只认 `\n\n`：OpenAI 兼容端点用的都是这个分隔符，`\r\n\r\n` 顺带兼容一下。
 */
function createRecordSplitter(onRecord) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.search(/\r?\n\r?\n/);
      if (at < 0) return;
      const record = buffer.slice(0, at);
      buffer = buffer.slice(at + (buffer[at] === '\r' ? 4 : 2));
      if (record.trim() !== '') onRecord(record);
    }
  };
}

/** 上游回了一个非 2xx：把状态码原样带给手机，界面按同一套错误分类翻。 */
async function upstreamFailureOf(response) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 400);
  } catch { /* 读不到正文就只报状态码 */ }
  return detail;
}

/** 一条消息里有没有图片：DSH 那条入站要经附件服务落盘，这里没有那只桥，明确拒而不是静默丢。 */
function hasImagePart(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && typeof part === 'object'
    && (part.type === 'image' || part.type === 'image_url'));
}

function contentTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * OpenAI 消息 → DSH 消息。形状照 DSH 自己的 OpenAI 网关那份写（`createGatewayMessage`）：
 * 文本是 part、assistant 的工具调用是 `tool-call`、工具结果是 `tool-result`，source 标出来源。
 * 只认文本，图片明确回 `image-unsupported`（见 hasImagePart）。
 */
function dshMessagesOf(raw, provider, model) {
  if (!Array.isArray(raw)) return [];
  const source = { kind: 'plugin:dsh-mobile-channel-proxy' };
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('unsupported-role');
    const role = item.role;
    if (hasImagePart(item.content)) throw new Error('image-unsupported');
    const text = contentTextOf(item.content);
    const id = randomUUID();
    if (role === 'system' || role === 'user') {
      return { id, role, content: [{ type: 'text', text }], source };
    }
    if (role === 'assistant') {
      const content = text ? [{ type: 'text', text }] : [];
      if (Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const fn = call.function && typeof call.function === 'object' ? call.function : {};
          content.push({
            type: 'tool-call',
            id: String(call.id ?? ''),
            name: String(fn.name ?? ''),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
          });
        }
      }
      return { id, role: 'assistant', content, source: { kind: 'model', provider, model } };
    }
    if (role === 'tool') {
      const callId = typeof item.tool_call_id === 'string' ? item.tool_call_id : '';
      return {
        id,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
        source: { kind: 'tool', callId },
      };
    }
    throw new Error('unsupported-role');
  });
}

/** OpenAI tools → DSH ToolSchema；非 function 的一律丢掉，不拿去麻烦模型。 */
function dshToolsOf(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || item.type !== 'function') continue;
    const fn = item.function && typeof item.function === 'object' ? item.function : null;
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
    const parameters = fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
      ? fn.parameters : {};
    tools.push({ name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters });
  }
  return tools.length > 0 ? tools : undefined;
}

/** DSH 的失败块 → 手机认得的短码。带上游状态码的优先，模型名写错这种确定性失败别让他重试。 */
function dshErrorCodeOf(reason) {
  const failure = reason && reason.failure && typeof reason.failure === 'object' ? reason.failure : {};
  const status = Number(failure.status);
  if (status === 401 || status === 403) return 'http-401';
  if (status === 429) return 'http-429';
  if (status === 404) return 'http-404';
  if (reason && reason.kind === 'aborted') return 'aborted';
  return 'host-model-failed';
}

/**
 * DSH 的增量块 → OpenAI chunk。手机那条解析路只认 OpenAI 形状，这里翻成同一份，
 * `client.ts` 不必为「经电脑转发」再分一套。失败块单独返回 `dshError`，不混进正文。
 */
function openAiChunkOf(chunk, model, id) {
  if (!chunk || typeof chunk !== 'object') return null;
  let delta = null;
  let finishReason = null;
  switch (chunk.type) {
    case 'text-delta': delta = { content: chunk.text }; break;
    case 'reasoning-delta': delta = { reasoning_content: chunk.text }; break;
    case 'tool-call-delta':
      delta = {
        tool_calls: [{
          index: chunk.index,
          id: String(chunk.id ?? ''),
          type: 'function',
          function: {
            ...(chunk.name === undefined ? {} : { name: chunk.name }),
            arguments: typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '',
          },
        }],
      };
      break;
    case 'finish': {
      const kind = chunk.reason && chunk.reason.kind;
      if (kind === 'error' || kind === 'aborted') {
        return { dshError: { code: dshErrorCodeOf(chunk.reason) } };
      }
      delta = {};
      finishReason = kind === 'tool-calls' ? 'tool_calls' : kind === 'max-tokens' ? 'length' : 'stop';
      break;
    }
    case 'usage':
    case 'block-start':
    case 'block-end':
      return null;
    default:
      return null;
  }
  return {
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** DSH 自己的模型服务：同进程直查，不写进 inject；缺了只让这一路回 503。 */
function hostLlmOf(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null;
    return ctx.get('llm') || null;
  } catch {
    return null;
  }
}

function jsonError(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error }));
}

/**
 * POST /api/mobile/v1/channels/chat（token）
 * { id, model, messages, tools?, toolChoice?, maxTokens?, temperature? }
 * → SSE：上游的每条 `data:` 原样成帧；失败时补一帧 `{ dshError: { code } }`。
 */
async function handleChannelChat(ctx, req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const id = body && typeof body.id === 'string' ? body.id.trim() : '';
  const model = body && typeof body.model === 'string' ? body.model.trim() : '';
  if (!id || !model) {
    jsonError(res, 400, { code: 'bad-request', message: '需要渠道 id 与模型' });
    return;
  }

  const found = await customChannelWithKey(ctx, id);
  // 只有「电脑上没有这条自建渠道」才退回 DSH 自己的模型服务；查配置本身失败要如实报，
  // 不能把宿主故障伪装成「换条路再试」。
  const viaDsh = !!(found.error && found.error.code === 'channel-not-found');
  if (found.error && !viaDsh) {
    jsonError(res, found.status || 400, found.error);
    return;
  }
  const url = viaDsh ? '' : chatCompletionUrlOf(found.channel.baseUrl);
  if (!viaDsh && url === '') {
    jsonError(res, 400, { code: 'bad-request', message: '这条渠道没有可用地址' });
    return;
  }

  const controller = new AbortController();
  const closed = () => controller.abort();
  res.on('close', closed);
  const timer = setTimeout(closed, UPSTREAM_IDLE_MS);

  let upstream;
  let llm = null;
  let dshOptions = null;
  const requestId = `chatcmpl-${randomUUID()}`;
  if (viaDsh) {
    llm = hostLlmOf(ctx);
    if (!llm || typeof llm.stream !== 'function') {
      clearTimeout(timer);
      res.off('close', closed);
      jsonError(res, 503, { code: 'host-llm-unavailable', message: '这台电脑上的模型服务不可用' });
      return;
    }
    try {
      dshOptions = {
        provider: id,
        model,
        messages: dshMessagesOf(body.messages, id, model),
        signal: controller.signal,
      };
      const tools = dshToolsOf(body.tools);
      if (tools) dshOptions.tools = tools;
      const maxTokens = Number(body && body.maxTokens);
      if (Number.isFinite(maxTokens) && maxTokens > 0) dshOptions.maxTokens = Math.trunc(maxTokens);
    } catch (error) {
      clearTimeout(timer);
      res.off('close', closed);
      jsonError(res, 400, { code: String(error && error.message).slice(0, 80), message: '这条对话没法转给 DSH' });
      return;
    }
  } else try {
    upstream = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(found.apiKey === '' ? {} : { authorization: `Bearer ${found.apiKey}` }),
      },
      body: JSON.stringify(upstreamBodyOf(body, model)),
    });
  } catch (error) {
    clearTimeout(timer);
    res.off('close', closed);
    jsonError(res, 502, { code: 'upstream-unreachable', message: String(error && error.message).slice(0, 200) });
    return;
  }

  if (!viaDsh && (!upstream.ok || !upstream.body)) {
    const detail = await upstreamFailureOf(upstream);
    clearTimeout(timer);
    res.off('close', closed);
    jsonError(res, upstream.status || 502, { code: 'upstream-failed', message: detail });
    return;
  }

  // 协议 v2 的设备逐帧加密：封装器由请求那一步挂上的解封信息生成（见 createFrameSealer）。
  // 要在 writeHead 之前算好，`x-dsh-proto` 只能在头发出去之前声明。
  const sealFrame = createFrameSealer(req);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'content-encoding': 'identity',
    ...(sealFrame ? { 'x-dsh-proto': '2' } : {}),
  });
  res.write(': connected\n\n');

  try {
    if (viaDsh) {
      for await (const chunk of llm.stream(dshOptions)) {
        if (controller.signal.aborted || res.writableEnded) break;
        const frame = openAiChunkOf(chunk, model, requestId);
        if (frame) writeSse(res, frame, { sealFrame });
      }
    } else {
      const pump = createRecordSplitter((record) => {
        const data = dataOfRecord(record);
        if (data === null || data === '[DONE]') return;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          return; // 半截 / 非 JSON 的 data 直接跳过，别把坏帧塞给手机
        }
        writeSse(res, payload, { sealFrame });
      });
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of upstream.body) {
        if (controller.signal.aborted || res.writableEnded) break;
        pump(decoder.decode(chunk, { stream: true }));
      }
    }
  } catch {
    if (!res.writableEnded) writeSse(res, { dshError: { code: 'host-model-failed' } }, { sealFrame });
  } finally {
    clearTimeout(timer);
    res.off('close', closed);
    try { res.end(); } catch { /* 已关闭 */ }
  }
}

module.exports = {
  handleChannelChat,
  chatCompletionUrlOf,
  upstreamBodyOf,
  createRecordSplitter,
  dshMessagesOf,
  dshToolsOf,
  openAiChunkOf,
};
