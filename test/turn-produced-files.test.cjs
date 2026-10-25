'use strict';

/**
 * 「这一轮动过的文件」按**轮**下发，而不是按单条消息。
 *
 * 为什么值得单钉一条：正文里提到的文件名能不能点，App 侧完全依赖这份清单
 * （`viewmodels/file-mentions` 拿它做唯一命中判定）。而这份清单从前是按**单条消息自己的
 * 工具调用**算的 —— 收尾答复那条消息里一个写操作都没有，于是正文里提到刚写好的文件时
 * 清单永远是空的，那个文件名在手机上一直是灰的（2026-10-25 现场：54 条消息只有 4 条带得动）。
 *
 * 口径对齐桌面 `dsh-client-ui-deliverables` 的 `selectProducedFiles(owner)`：按整轮取。
 * 所以同一轮里**先发的消息**也要能看到这一轮后几步才写出来的文件。
 *
 * 跑法：node --test dsh-mobile-plugin/test/turn-produced-files.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMessages } = require('../lib/mobile/sessions.js');

/** 一条带写操作工具调用的助手消息。 */
function writeEvent({ seq, turn, step, callId, path }) {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '写下第一版。' },
          { type: 'tool-call', id: callId, name: 'write', arguments: { path } },
        ],
      },
    },
  };
}

/** 那条工具调用的结果（成功）。 */
function resultEvent({ seq, callId }) {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'tool/result',
    data: { message: { source: { callId }, content: [{ type: 'text', text: 'ok' }] } },
  };
}

/** 一条只有正文的助手消息（收尾答复就是这样：自己没有任何写操作）。 */
function answerEvent({ seq, turn, step, text }) {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'assistant/message',
    data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

const assistants = (items) => items.filter((item) => item.role === 'assistant');

test('收尾答复要带得上这一轮写过的文件（它自己没有任何写操作）', () => {
  const items = deriveMessages([
    writeEvent({ seq: 1, turn: 1, step: 1, callId: 'c1', path: '/w/docs/a.md' }),
    resultEvent({ seq: 2, callId: 'c1' }),
    answerEvent({ seq: 3, turn: 1, step: 2, text: '写好了 `a.md`。' }),
  ]);

  const closing = assistants(items).at(-1);
  assert.equal(closing.text, '写好了 `a.md`。');
  assert.deepEqual(closing.producedFiles, ['/w/docs/a.md'], '收尾答复必须带上这一轮的产出清单');
});

test('同一轮里先发的消息也要看到后几步才写出来的文件（按整轮，不按先后）', () => {
  const items = deriveMessages([
    answerEvent({ seq: 1, turn: 1, step: 1, text: '先说一句。' }),
    writeEvent({ seq: 2, turn: 1, step: 2, callId: 'c2', path: '/w/b.ts' }),
    resultEvent({ seq: 3, callId: 'c2' }),
    answerEvent({ seq: 4, turn: 1, step: 3, text: '写好了 `b.ts`。' }),
  ]);

  const list = assistants(items);
  assert.equal(list.length, 3);
  for (const message of list) {
    assert.deepEqual(message.producedFiles, ['/w/b.ts'], `第 ${message.seq} 条也该带上整轮的清单`);
  }
});

test('一轮里写过好几份就都得在，按写入顺序、不重复', () => {
  const items = deriveMessages([
    writeEvent({ seq: 1, turn: 1, step: 1, callId: 'c1', path: '/w/a.md' }),
    resultEvent({ seq: 2, callId: 'c1' }),
    writeEvent({ seq: 3, turn: 1, step: 2, callId: 'c2', path: '/w/b.md' }),
    resultEvent({ seq: 4, callId: 'c2' }),
    writeEvent({ seq: 5, turn: 1, step: 3, callId: 'c3', path: '/w/a.md' }),
    resultEvent({ seq: 6, callId: 'c3' }),
    answerEvent({ seq: 7, turn: 1, step: 4, text: '都好了。' }),
  ]);

  assert.deepEqual(assistants(items).at(-1).producedFiles, ['/w/a.md', '/w/b.md'], '同一份写两次只留一条');
});

test('不同轮之间不许串味', () => {
  const items = deriveMessages([
    writeEvent({ seq: 1, turn: 1, step: 1, callId: 'c1', path: '/w/one.md' }),
    resultEvent({ seq: 2, callId: 'c1' }),
    answerEvent({ seq: 3, turn: 1, step: 2, text: '第一轮完了。' }),
    writeEvent({ seq: 4, turn: 2, step: 1, callId: 'c2', path: '/w/two.md' }),
    resultEvent({ seq: 5, callId: 'c2' }),
    answerEvent({ seq: 6, turn: 2, step: 2, text: '第二轮完了。' }),
  ]);

  const list = assistants(items);
  const first = list.filter((item) => item.seq < 4);
  const second = list.filter((item) => item.seq >= 4);
  assert.deepEqual(first.at(-1).producedFiles, ['/w/one.md']);
  assert.deepEqual(second.at(-1).producedFiles, ['/w/two.md']);
  assert.ok(!first.at(-1).producedFiles.includes('/w/two.md'), '第一轮里不该出现第二轮的文件');
});

test('写失败（工具报错）的文件不算这一轮产出', () => {
  const items = deriveMessages([
    {
      seq: 1,
      time: 1_700_000_000_001,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: { path: '/w/bad.md' } }],
        },
      },
    },
    {
      seq: 2,
      time: 1_700_000_000_002,
      type: 'tool/result',
      data: {
        message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'disk full' }], isError: true },
      },
    },
    answerEvent({ seq: 3, turn: 1, step: 2, text: '没写成。' }),
  ]);

  assert.equal(assistants(items).at(-1).producedFiles, undefined, '失败的那次不该进清单');
});
