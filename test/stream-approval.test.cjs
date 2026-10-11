'use strict';

/**
 * 审批帧转发的契约测试。
 *
 * 宿主 `@deepseek-ai/dsh-host-apiproxy` 的 `requestedFrame()` 发出的是 **mux 帧
 * `approval/requested`**（`rpcId` 在帧级、`approvalId` 在 payload），而会话事件
 * `approval/asked` 只是同一件事的持久化形态、**不带 rpcId**。
 *
 * 旧实现只给 `approval/asked` 合入 `frame.rpcId`：
 *   const value = { ...p, ...(p.type === 'approval/asked' && frame.rpcId ? { rpcId: frame.rpcId } : {}) };
 * 于是 App 收到的 `approval/requested` 永远没有 rpcId，而 `/approval/respond` 的
 * rpcId 是宿主 `pendingApprovals` 表的键 —— 用 approvalId 冒充会被判 `not-pending`，
 * 插件回 409「该审批已完成或不可回答」。
 *
 * 运行：node --test test/stream-approval.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleStream } = require('../lib/mobile/stream.js');

function response() {
  const chunks = [];
  const listeners = {};
  return {
    chunks,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(String(chunk)); },
    end() { this.ended = true; },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
  };
}

function request(url, headers = {}) {
  const req = new (require('node:events').EventEmitter)();
  req.url = url;
  req.headers = headers;
  return req;
}

/** 从 SSE chunk 里提取 `data:` 行的 JSON。 */
function dataFrames(chunks) {
  const out = [];
  for (const chunk of chunks) {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6).trim()));
    }
  }
  return out;
}

/** 用一批 mux 帧跑一遍 handleStream，返回交付给客户端的 data 帧。 */
async function run(frames) {
  const res = response();
  const req = request('/api/mobile/v1/session/stream?sessionId=s-1');
  const ctx = {
    apiProxy: {
      events: {
        mux: async function* () { for (const frame of frames) yield frame; },
      },
      sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) },
    },
  };
  await handleStream(ctx, req, res);
  return dataFrames(res.chunks);
}

test('mux approval/requested 必须把帧级 rpcId 交给客户端', async () => {
  const frames = await run([
    { rpcId: 'rpc-approval-1', payload: { type: 'approval/requested', sessionId: 's-1', approvalId: 'ap-1', toolName: 'Bash', reason: 'needs shell' } },
  ]);
  const frame = frames.find((f) => f.type === 'approval/requested');
  assert.ok(frame, 'approval/requested 帧必须被转发');
  assert.equal(frame.rpcId, 'rpc-approval-1', 'rpcId 必须是帧级 rpcId，不能缺省');
  assert.equal(frame.approvalId, 'ap-1');
  assert.equal(frame.toolName, 'Bash');
  assert.equal(frame.reason, 'needs shell');
});

test('mux approval/asked 同样合入帧级 rpcId', async () => {
  const frames = await run([
    { rpcId: 'rpc-approval-2', payload: { type: 'approval/asked', sessionId: 's-1', approvalId: 'ap-2', toolName: 'Write' } },
  ]);
  const frame = frames.find((f) => f.type === 'approval/asked');
  assert.ok(frame);
  assert.equal(frame.rpcId, 'rpc-approval-2');
  assert.equal(frame.approvalId, 'ap-2');
});

test('结算帧原样转发，不注入 rpcId', async () => {
  const frames = await run([
    { rpcId: 'rpc-ignored-1', payload: { type: 'approval/resolved', sessionId: 's-1', approvalId: 'ap-1', outcome: 'allowed-once' } },
    { rpcId: 'rpc-ignored-2', payload: { type: 'approval/decided', sessionId: 's-1', data: { id: 'ap-1', outcome: 'allowed-once' } } },
  ]);
  const resolved = frames.find((f) => f.type === 'approval/resolved');
  assert.ok(resolved);
  assert.equal(resolved.rpcId, undefined);
  assert.equal(resolved.outcome, 'allowed-once');
  const decided = frames.find((f) => f.type === 'approval/decided');
  assert.ok(decided);
  assert.equal(decided.rpcId, undefined);
  assert.equal(decided.data.id, 'ap-1');
});

test('question/requested 仍合入帧级 rpcId（不得被审批改动回退）', async () => {
  const frames = await run([
    { rpcId: 'rpc-question-1', payload: { type: 'question/requested', sessionId: 's-1', questions: [{ id: 'q1', question: 'ok?' }] } },
  ]);
  const frame = frames.find((f) => f.type === 'question/requested');
  assert.ok(frame);
  assert.equal(frame.rpcId, 'rpc-question-1');
  assert.equal(frame.questions.length, 1);
});

test('session/event 形态的 approval/asked 保持原 wire：不带 rpcId', async () => {
  const frames = await run([
    { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'approval/asked', seq: 3, data: { id: 'ap-3', toolName: 'Bash' } } } },
  ]);
  const frame = frames.find((f) => f.type === 'approval/asked');
  assert.ok(frame, '会话事件必须原样交付');
  assert.equal(frame.rpcId, undefined, '会话事件形态没有 rpcId —— App 不得据此建面板');
  assert.equal(frame.seq, 3);
  assert.equal(frame.data.id, 'ap-3');
});

test('只转发目标会话的审批帧', async () => {
  const frames = await run([
    { rpcId: 'rpc-other', payload: { type: 'approval/requested', sessionId: 's-2', approvalId: 'ap-other', toolName: 'Bash' } },
    { rpcId: 'rpc-mine', payload: { type: 'approval/requested', sessionId: 's-1', approvalId: 'ap-mine', toolName: 'Bash' } },
  ]);
  const approvals = frames.filter((f) => f.type === 'approval/requested');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approvalId, 'ap-mine');
  assert.equal(approvals[0].rpcId, 'rpc-mine');
});

test('源码契约：审批 rpcId 合并按可回答类型集合，不写死 approval/asked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'stream.js'), 'utf8');
  assert.match(src, /ANSWERABLE_APPROVAL_TYPES = new Set\(\['approval\/requested', 'approval\/asked'\]\)/);
  assert.match(src, /ANSWERABLE_APPROVAL_TYPES\.has\(p\.type\) && frame\.rpcId/);
  assert.doesNotMatch(src, /p\.type === 'approval\/asked' && frame\.rpcId/);
});
