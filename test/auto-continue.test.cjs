'use strict';

/**
 * 守卫：输出 token 用满之后替用户续一句「继续」。
 *
 * 这一层的风险全在「多代发」上 —— 事件流重连重放、一次截断续成无限串、把电脑上开的轮也
 * 续了。四类断言：
 *   1. 手机发起的轮被 max-tokens 截断 → 代发一次，文本与 requestId 都对；
 *   2. 同一轮重复到达只代发一次；
 *   3. 电脑发的轮、正常收尾的轮、已续满三次的串 → 一个字都不发；
 *   4. 代发失败不抛（它在事件循环里），下次同类事件还能再试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  observeAutoContinue,
  AUTO_CONTINUE_TEXT,
  AUTO_CONTINUE_MAX_ROUNDS,
} = require('../lib/mobile/auto-continue.js');
const { autoContinueTurnsOf } = require('../lib/mobile/session-cache.js');

const AT = 1780000000000;

/** 一条 user 消息事件；`mobile` 决定它是不是移动端发的。 */
function userEvent(text, { clientMessageId } = {}) {
  return {
    type: 'user/message',
    seq: 1,
    time: AT,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      ...(clientMessageId === undefined
        ? { source: { kind: 'user', rpcId: 'desktop-req-1' } }
        : { source: { kind: 'user', rpcId: `mobile:${clientMessageId}` }, clientMessageId }),
    },
  };
}

/** 一串「用户说一句 → 模型续过 N 次」的历史。 */
function historyWith(messages) {
  return { result: { ok: true, value: { events: messages } } };
}

function maxTokensEnd(turn) {
  return { type: 'turn/end', seq: 99, time: AT, data: { turn, reason: { kind: 'max-tokens' } } };
}

/** 假 ctx：只记 prompt 收了几发、每发带了什么。 */
function fakeCtx(events, promptImpl) {
  const sent = [];
  const ctx = {
    apiProxy: {
      sessions: {
        history: async () => historyWith(events),
        prompt: async (request) => {
          sent.push(request.payload);
          if (promptImpl) return promptImpl(request);
          return { result: { ok: true, value: { accepted: true } } };
        },
      },
    },
  };
  return { ctx, sent };
}

test('手机发起的轮被 max-tokens 截断：代发一句「继续」，并带上可认回的 rpcId', async () => {
  const { ctx, sent } = fakeCtx([userEvent('把这份文档写完', { clientMessageId: 'c-1' })]);
  const did = await observeAutoContinue(ctx, 's-1', maxTokensEnd(4));
  assert.equal(did, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, [{ type: 'text', text: AUTO_CONTINUE_TEXT }]);
  assert.equal(sent[0].requestId, 'mobile:auto-continue-4-0', '第 0 次续写要能靠 rpcId 认回来');
});

test('同一轮的 turn/end 重放只代发一次', async () => {
  const { ctx, sent } = fakeCtx([userEvent('写长一点', { clientMessageId: 'c-2' })]);
  assert.equal(await observeAutoContinue(ctx, 's-2', maxTokensEnd(7)), true);
  assert.equal(await observeAutoContinue(ctx, 's-2', maxTokensEnd(7)), false, '重放的同一轮不许再发');
  assert.equal(sent.length, 1);
});

test('电脑发起的轮一动不动', async () => {
  const { ctx, sent } = fakeCtx([userEvent('桌面发的一句')]);
  assert.equal(await observeAutoContinue(ctx, 's-3', maxTokensEnd(2)), false);
  assert.equal(sent.length, 0, '电脑上用户就在键盘前，不许替他发话');
});

test('正常收尾 / 中止 / 出错都不代发', async () => {
  const { ctx, sent } = fakeCtx([userEvent('手机发的', { clientMessageId: 'c-4' })]);
  for (const kind of ['stop', 'aborted', 'error', 'tool-calls']) {
    const end = { type: 'turn/end', seq: 9, time: AT, data: { turn: 1, reason: { kind } } };
    assert.equal(await observeAutoContinue(ctx, 's-4', end), false, `${kind} 不该触发续写`);
  }
  assert.equal(sent.length, 0);
});

test('一串最多续三次，第三次之后停手', async () => {
  const chain = [userEvent('写一篇长的', { clientMessageId: 'c-5' })];
  for (let round = 0; round < AUTO_CONTINUE_MAX_ROUNDS; round += 1) {
    chain.push(userEvent(AUTO_CONTINUE_TEXT, { clientMessageId: `auto-continue-1-${round}` }));
  }
  const { ctx, sent } = fakeCtx(chain);
  assert.equal(await observeAutoContinue(ctx, 's-5', maxTokensEnd(2)), false, '已经续满就要停手');
  assert.equal(sent.length, 0);
});

test('续过两次还剩最后一次：round 要接着数，不能从 0 重来', async () => {
  const chain = [
    userEvent('写一篇长的', { clientMessageId: 'c-6' }),
    userEvent(AUTO_CONTINUE_TEXT, { clientMessageId: 'auto-continue-1-0' }),
    userEvent(AUTO_CONTINUE_TEXT, { clientMessageId: 'auto-continue-1-1' }),
  ];
  const { ctx, sent } = fakeCtx(chain);
  assert.equal(await observeAutoContinue(ctx, 's-6', maxTokensEnd(2)), true);
  assert.equal(sent[0].requestId, 'mobile:auto-continue-2-2');
});

test('读不到会话 / 事件残缺：静默放过，绝不抛', async () => {
  const ctx = { apiProxy: { sessions: { history: async () => ({ result: { ok: false, error: { code: 'x' } } }) } } };
  assert.equal(await observeAutoContinue(ctx, 's-7', maxTokensEnd(1)), false);
  assert.equal(await observeAutoContinue(ctx, null, maxTokensEnd(1)), false);
  assert.equal(await observeAutoContinue(ctx, 's-7', { type: 'turn/end' }), false);
  assert.equal(await observeAutoContinue(ctx, 's-7', { type: 'assistant/chunk', data: { turn: 1 } }), false);
});

test('代发失败不抛，下一次同类事件还能再试', async () => {
  let fail = true;
  const { ctx, sent } = fakeCtx(
    [userEvent('手机发的', { clientMessageId: 'c-8' })],
    () => {
      if (fail) throw new Error('网关 502');
      return { result: { ok: true, value: { accepted: true } } };
    },
  );
  assert.equal(await observeAutoContinue(ctx, 's-8', maxTokensEnd(3)), false);
  assert.equal(sent.length, 1);
  fail = false;
  assert.equal(await observeAutoContinue(ctx, 's-8', maxTokensEnd(3)), true, '失败没占住这一轮，重试要能发出去');
  assert.equal(sent.length, 2);
});

test('换一份 ctx 不复用上一份的「已代发」记账', async () => {
  const events = [userEvent('手机发的', { clientMessageId: 'c-9' })];
  const first = fakeCtx(events);
  assert.equal(await observeAutoContinue(first.ctx, 's-9', maxTokensEnd(5)), true);
  const second = fakeCtx(events);
  assert.equal(await observeAutoContinue(second.ctx, 's-9', maxTokensEnd(5)), true);
  // 记账表自己按 ctx 隔离：清掉之后同一份 ctx 还能再发一次。
  autoContinueTurnsOf(first.ctx).clear();
  assert.equal(await observeAutoContinue(first.ctx, 's-9', maxTokensEnd(5)), true);
});
