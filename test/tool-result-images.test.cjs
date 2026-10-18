'use strict';
/**
 * tool/result 的两种形状：图片块与成败标记。
 *
 * 真机现象：生成图片的工具跑完，桌面能看到图，App 的工具卡里什么都没有 —— 展开只有一段
 * 文字。根因是投影把 `message.content` 当成「信封」（`content[0] = { isError, content }`）
 * 去剥，而宿主现在直接发内容块数组、成败在 `message.isError` 上：于是图片块被整段剥掉，
 * 失败的工具还会显示成成功（工具卡一直挂「运行中」）。
 *
 * 这里用真实事件形状驱动导出的 deriveMessages（不经过 HTTP）：
 *   - 新形状：`content` 直接是块数组 + `message.isError`；
 *   - 旧形状：`content[0]` 是信封 —— 不能因为修新形状把它弄坏。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMessages } = require('../lib/mobile/sessions.js');

/** 一条用户消息，让投影有正常的对话起点。 */
function userEvent(text) {
  return { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }] } } };
}

/** 一条携带 tool-call 的 assistant/message。 */
function assistantCallEvent(callId, name, args) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args || {}) }],
      },
    },
  };
}

/** 新形状的 tool/result：content 直接是块数组，成败在 message.isError 上。 */
function resultEvent(callId, parts, isError) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: parts,
        isError: isError === true,
      },
    },
  };
}

/** 旧形状的 tool/result：content[0] 是 { isError, content } 信封。 */
function legacyResultEvent(callId, parts, isError) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ isError: isError === true, content: parts }],
      },
    },
  };
}

/** 跑一次投影，返回扁平的工具卡列表。 */
function toolCards(events) {
  const out = [];
  for (const item of deriveMessages(events)) {
    for (const block of item.blocks || []) {
      if (block.type === 'tool-call') out.push(block);
    }
  }
  return out;
}

test('新形状：tool/result 里的图片挂到消息的附件上，工具卡里只剩文字', () => {
  const events = [
    userEvent('画一张图'),
    assistantCallEvent('call_img', 'codex_image_generate', { prompt: '一只猫' }),
    resultEvent('call_img', [
      { type: 'text', text: 'Generated a 1024x1024 image.' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'cat.png' },
    ]),
  ];
  const [card] = toolCards(events);
  assert.equal(card.state, 'ok');
  assert.match(card.output, /Generated/);
  assert.equal(card.images, undefined, '工具卡不再重复画这张图（两处画会把字节翻倍）');

  const assistant = deriveMessages(events).find((item) => item.role === 'assistant');
  assert.equal(assistant.images.length, 1);
  assert.equal(assistant.images[0].mediaType, 'image/png');
  assert.equal(assistant.images[0].data, 'iVBORw0KGgo=');
  assert.equal(assistant.images[0].name, 'cat.png');
});

test('新形状：结果级 isError 读出失败态（interrupted 仍是已停止）', () => {
  const events = [
    userEvent('跑个命令'),
    assistantCallEvent('call_err', 'bash', { command: 'exit 1' }),
    resultEvent('call_err', [{ type: 'text', text: 'command failed' }], true),
  ];
  const [card] = toolCards(events);
  assert.equal(card.state, 'error');
  assert.match(card.output, /command failed/);
});

test('旧形状没有被新形状的判定弄坏：图片与失败态照样认得', () => {
  const events = [
    userEvent('画一张图'),
    assistantCallEvent('call_old', 'codex_image_generate', { prompt: '一只狗' }),
    legacyResultEvent('call_old', [
      { type: 'text', text: 'generated' },
      { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQ', name: 'dog.jpg' },
    ]),
  ];
  const [card] = toolCards(events);
  assert.equal(card.state, 'ok');
  assert.equal(card.images, undefined);
  const legacyAssistant = deriveMessages(events).find((item) => item.role === 'assistant');
  assert.equal(legacyAssistant.images.length, 1);
  assert.equal(legacyAssistant.images[0].mediaType, 'image/jpeg');

  const failed = [
    userEvent('跑个命令'),
    assistantCallEvent('call_old_err', 'bash', { command: 'exit 1' }),
    legacyResultEvent('call_old_err', [{ type: 'text', text: 'boom' }], true),
  ];
  const [errCard] = toolCards(failed);
  assert.equal(errCard.state, 'error');
});

test('没有图片的普通结果不长出 images，也没有 data 的图片块被丢弃', () => {
  const events = [
    userEvent('看下文件'),
    assistantCallEvent('call_read', 'read', { path: '/tmp/a.md' }),
    resultEvent('call_read', [{ type: 'text', text: 'file body' }]),
    assistantCallEvent('call_ref', 'view_image', { path: '/tmp/a.png' }),
    resultEvent('call_ref', [{ type: 'image', attachment: { attachmentId: 'sha256:abc' } }]),
  ];
  const cards = toolCards(events);
  assert.equal(cards[0].images, undefined);
  assert.equal(cards[0].output, 'file body');
  assert.equal(cards[1].images, undefined, '只有 attachment 引用、没有 data 的块不该当成可显示图片');
});

test('流式帧与历史同一口径：两种形状都走解包，不靠 content[0].isError', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'mobile', 'history-derive.js'),
    'utf8',
  );
  assert.match(source, /function toolResultParts\(msg\)/);
  assert.match(source, /const \{ parts, isError \} = toolResultParts\(msg\);/);
});

test('工具产出的图也挂成这条消息的图片附件（App 画在气泡上方的那张卡）', () => {
  const events = [
    userEvent('画一张图'),
    assistantCallEvent('call_img', 'codex_image_generate', { prompt: '一只猫' }),
    resultEvent('call_img', [
      { type: 'text', text: 'Generated a 1024x1024 image.' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'cat.png' },
    ]),
  ];
  const assistant = deriveMessages(events).find((item) => item.role === 'assistant');
  assert.ok(assistant, '必须有助手消息');
  assert.equal(assistant.images.length, 1);
  assert.equal(assistant.images[0].mediaType, 'image/png');
  assert.equal(assistant.images[0].data, 'iVBORw0KGgo=');
  assert.equal(assistant.images[0].name, 'cat.png');
});
