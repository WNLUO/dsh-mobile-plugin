// 2026-11-26：手机够不着的渠道，由电脑代发模型请求（只转发模型调用，会话仍在手机上）。
'use strict';

/**
 * `POST /api/mobile/v1/channels/chat`：手机借这台电脑的手，向一条自建渠道发一次流式对话。
 *
 * 为什么需要：手机上的本机 Agent 是自己直连渠道的，但渠道地址可能是 `127.0.0.1`（Ollama、
 * one-api 跑在这台电脑上）、或者只在内网可达 —— 手机拨不到。这样一条渠道不该变成「用不了」，
 * 让电脑转一手就通了。
 *
 * 边界：**只转发模型调用这一层**。会话记录、手机侧的工具循环仍在手机上，这条路由不建会话、
 * 不写任何日志、不碰工作区。请求体只收 OpenAI 兼容对话的四样东西（messages / model /
 * tools / 生成参数），渠道的地址与 Key 一律用宿主自己那一份，手机给什么 id 就查什么 id。
 *
 * 回包是 SSE：把上游的 `data:` 逐条解析出来，按同一条流式通道（`writeSse`）回给手机 ——
 * 协议 v2 的设备逐帧加密，与 `/session/stream` 同一套封装（见 `createFrameSealer`）。
 * 上游中途失败时补一帧 `{ dshError }`，手机据此把它翻成界面上的失败原因。
 */

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

/**
 * POST /api/mobile/v1/channels/chat（token）
 * { id, model, messages, tools?, toolChoice?, maxTokens?, temperature? }
 * → SSE：上游的每条 `data:` 原样成帧；失败时补一帧 `{ dshError: { code, status? } }`。
 */
async function handleChannelChat(ctx, req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const id = body && typeof body.id === 'string' ? body.id.trim() : '';
  const model = body && typeof body.model === 'string' ? body.model.trim() : '';
  if (!id || !model) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: '需要渠道 id 与模型' } }));
    return;
  }

  const found = await customChannelWithKey(ctx, id);
  if (found.error) {
    res.writeHead(found.status || 400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: found.error }));
    return;
  }
  const url = chatCompletionUrlOf(found.channel.baseUrl);
  if (url === '') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: '这条渠道没有可用地址' } }));
    return;
  }

  const controller = new AbortController();
  const closed = () => controller.abort();
  res.on('close', closed);
  const timer = setTimeout(closed, UPSTREAM_IDLE_MS);

  let upstream;
  try {
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
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code: 'upstream-unreachable', message: String(error && error.message).slice(0, 200) } }));
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstreamFailureOf(upstream);
    clearTimeout(timer);
    res.off('close', closed);
    res.writeHead(upstream.status || 502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code: 'upstream-failed', message: detail } }));
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

  try {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of upstream.body) {
      if (controller.signal.aborted || res.writableEnded) break;
      pump(decoder.decode(chunk, { stream: true }));
    }
  } catch {
    if (!res.writableEnded) writeSse(res, { dshError: { code: 'upstream-interrupted' } }, { sealFrame });
  } finally {
    clearTimeout(timer);
    res.off('close', closed);
    try { res.end(); } catch { /* 已关闭 */ }
  }
}

module.exports = { handleChannelChat, chatCompletionUrlOf, upstreamBodyOf, createRecordSplitter, dataOfRecord };
