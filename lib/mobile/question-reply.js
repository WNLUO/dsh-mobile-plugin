'use strict';

/**
 * `ask_user_question` 的问答派生（历史与直播共用这一份）。
 *
 * 桌面那边由 `dsh-client-ui-user-questions` 的 `answeredQuestionDefinition` 把「问 + 答」
 * 折成一条右对齐的用户气泡（`QuestionReplyView`）：每道题在上、用户给的答案在下，跳过显示
 * 「已跳过」。手机此前只把提问卡收掉，对话记录里看不到用户选了什么 —— 这里补上同一件事。
 *
 * 只认 `ask_user_question` 的调用与其结果**成对**出现：
 *  - 计划评审（`intent.kind === 'plan-review'`）不是普通选择题，走它自己的接管卡，这里不出气泡；
 *  - pending（限时提问还没答）/ 失败 / 题数对不上 / 畸形的结果都不算，交回通用工具行；
 *  - 题里任一题带 plan-review、或没有题，整批都不出（与桌面 `callQuestions` 同口径）。
 *
 * 状态按 callId 记：调用先到、结果后到时才能把题目和答案配起来。历史与直播各持一份，
 * 因为两边的游标互不相干（见 `history-derive.js` 与 `stream.js`）。
 */

/** 计划评审的 intent.kind，出现在任一题里就不当普通提问。 */
const PLAN_REVIEW = 'plan-review';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 从调用参数解析题目；解析失败 / 无题 / 有题带 plan-review intent 时返回 null。
 *
 * `arguments` 既可能是 JSON 原文，也可能是已解析对象（PTC / 合成事件两种形状都见过）。
 */
function questionsOf(args) {
  const value = typeof args === 'string' ? parseJsonRecord(args) : (isRecord(args) ? args : null);
  if (!value || !Array.isArray(value.questions) || value.questions.length === 0) return null;
  const ids = new Set();
  const questions = [];
  for (const question of value.questions) {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string') return null;
    if (ids.has(question.id)) return null;
    if (isRecord(question.intent) && question.intent.kind === PLAN_REVIEW) return null;
    ids.add(question.id);
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' && question.header ? { header: question.header } : {}),
    });
  }
  return questions;
}

/**
 * 从工具结果解析答案批次；pending / 失败 / 题数对不上 / 畸形返回 null。
 *
 * 结果正文是宿主塞给模型的那段 JSON：`{"answers":[{"id","selected","custom"?}]}`。
 */
function answersOf(resultMessage, questions) {
  if (!isRecord(resultMessage) || resultMessage.isError === true) return null;
  const content = resultMessage.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
  const value = parseJsonRecord(block.text);
  if (!value || value.pending === true || !Array.isArray(value.answers)) return null;
  if (value.answers.length !== questions.length) return null;
  const ids = new Set(questions.map((question) => question.id));
  const answers = [];
  for (const answer of value.answers) {
    if (!isRecord(answer) || typeof answer.id !== 'string' || !ids.delete(answer.id)) return null;
    if (!Array.isArray(answer.selected) || !answer.selected.every((label) => typeof label === 'string')) return null;
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return null;
    answers.push({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    });
  }
  return answers;
}

/** 从工具结果事件取 callId（两种宿主形状：`message.source.callId` / `message.toolCallId`）。 */
function callIdOfResult(data) {
  const message = data && data.message;
  if (!isRecord(message)) return '';
  const source = message.source;
  if (isRecord(source) && source.callId != null) return String(source.callId);
  return message.toolCallId != null ? String(message.toolCallId) : '';
}

/**
 * 建一份问答累积器。`note(event)` 喂原始会话事件：
 *  - `tool/call` / `assistant/message` 里的 `ask_user_question` 调用 → 记下题目，返回 null；
 *  - 对应的 `tool/result` 且答案合法 → 吐出结构化行（`kind:'question-reply'`），否则 null。
 *
 * 返回的行形状对齐 App 的 `ChatMessage`（`text` 空串、内容全在 `questionReply` 上）。
 */
function createQuestionReplyTracker() {
  /** callId → 题目数组。 */
  const questionsByCall = new Map();

  const rememberCall = (callId, args) => {
    if (!callId) return;
    const questions = questionsOf(args);
    if (questions) questionsByCall.set(callId, questions);
  };

  function note(event) {
    if (!event || typeof event.type !== 'string') return null;

    if (event.type === 'tool/call') {
      const data = event.data;
      if (!isRecord(data) || data.name !== 'ask_user_question') return null;
      rememberCall(data.callId != null ? String(data.callId) : '', data.arguments);
      return null;
    }

    if (event.type === 'assistant/message') {
      const message = event.data && event.data.message;
      if (!isRecord(message) || !Array.isArray(message.content)) return null;
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool-call' || block.name !== 'ask_user_question') continue;
        rememberCall(block.id != null ? String(block.id) : '', block.arguments);
      }
      return null;
    }

    if (event.type !== 'tool/result') return null;
    const data = event.data;
    const callId = callIdOfResult(data);
    const questions = callId ? questionsByCall.get(callId) : undefined;
    if (!questions) return null;
    const answers = answersOf(data.message, questions);
    if (!answers) return null;
    questionsByCall.delete(callId);
    return {
      id: `question-reply-${callId}`,
      kind: 'question-reply',
      text: '',
      questionReply: { callId, questions, answers },
      seq: Number.isSafeInteger(event.seq) ? event.seq : 0,
      time: typeof event.time === 'number' ? event.time : 0,
    };
  }

  return { note };
}

module.exports = {
  createQuestionReplyTracker,
  questionsOf,
  answersOf,
};
