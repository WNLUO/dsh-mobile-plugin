'use strict';

/**
 * 「阶段」：模型这一轮自己写在待办清单上的位置（第几条 / 共几条 / 那条叫什么）。
 *
 * `todo_write` 的参数是整份清单，原样下发等于把一份可能几十条的中文列表搬上线路；手机要的
 * 只有两样：现在在第几步，以及那条待办的一行字。所以这里给两个纯函数 —— 一份最小投影
 * （`slimTodoArguments`）和从待办里挑当前那条的口径（`todoPhaseOf`）。直播（`wire-cut.js`）
 * 与历史（`history-derive.js` 的 `parseBlocks`）走的都是这两个函数，两条路只有一份说法。
 *
 * 上限只有一处：条数与单条字数都在这两个常量里，投影与阶段判定共用；字数沿用过程清单摘要
 * 那一档（`STEP_SUMMARY_MAX`），因为手机上它们画的都是同一行。不碰 ctx、不发 RPC。
 */

const { STEP_SUMMARY_MAX, clampSummary } = require('./step-index.js');

/** 一份清单最多下发这么多条：再往后不是「阶段」而是第二份清单。 */
const TODO_MAX_ITEMS = 20;

/** 单条 content 的字数上限：与过程清单的一行摘要同一档（`STEP_SUMMARY_MAX`）。 */
const TODO_CONTENT_MAX = STEP_SUMMARY_MAX;

/** 待办的两种「当前」状态：先认正在做的，没有在做的才退到没做的。 */
const ACTIVE_STATUS = 'in_progress';
const NEXT_STATUS = 'pending';

/**
 * 参数 → 待办数组。
 *
 * 认三种输入：宿主给的 JSON 字符串（`{"todos":[...]}`）、已经解析过的同形状对象，以及投影
 * 之后那份 `[{ c, s }]`（手机上再算阶段时就是这个形状）。认不出就返回 null —— 调用方按
 * 「拿不到」处理，不抛错。
 */
function todoListOf(raw) {
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.todos)) return value.todos;
  return null;
}

/** 一条待办 → `{ content, status }`（两种字段名都认：`content/status` 与投影后的 `c/s`）。 */
function normalizeTodo(item) {
  if (!item || typeof item !== 'object') return null;
  const content = typeof item.content === 'string' ? item.content : (typeof item.c === 'string' ? item.c : '');
  const status = typeof item.status === 'string' ? item.status : (typeof item.s === 'string' ? item.s : '');
  if (content === '') return null;
  return { content, status };
}

/** 整份清单 → 规范化的待办数组；认不出返回 null。 */
function normalizeTodos(raw) {
  const list = todoListOf(raw);
  if (list === null) return null;
  const out = [];
  for (const item of list) {
    const todo = normalizeTodo(item);
    if (todo !== null) out.push(todo);
  }
  return out;
}

/**
 * `todo_write` 的参数 → 下发用的最小投影字符串（`[{c,s}]` 的 JSON）。
 *
 * 截断只在这里做一次：单条 content 走 `clampSummary`（同一档字数、超出用省略号收尾），
 * 整份最多 `TODO_MAX_ITEMS` 条。**空清单返回 `'[]'`**——那是「一条待办都没有」的有效答案，
 * 回 `undefined` 会让手机把上一份清单继续挂在屏幕上。解析不了（畸形 JSON、认不出的形状）
 * 才回 `undefined`，调用方按「没有参数」处理。
 */
function slimTodoArguments(raw) {
  const todos = normalizeTodos(raw);
  if (todos === null) return undefined;
  const kept = todos.slice(0, TODO_MAX_ITEMS).map((todo) => ({
    c: clampSummary(todo.content, TODO_CONTENT_MAX),
    s: todo.status,
  }));
  return JSON.stringify(kept);
}

/**
 * 一份待办数组 → 当前阶段 `{ index, total, label }`，挑不出当前那条时返回 null。
 *
 * 判据与桌面一致：取**第一个** `in_progress`；一条都没有正在做的，就取第一个 `pending`。
 * `index` 是它在整表里的序号（从 1 起，不是「未完成里的第几条」），`total` 是整表条数；
 * 全部做完时没有「当前」可言，返回 null。`label` 的字数口径与投影一致。
 */
function todoPhaseOf(todos) {
  const list = normalizeTodos(todos);
  if (list === null || list.length === 0) return null;
  let at = list.findIndex((todo) => todo.status === ACTIVE_STATUS);
  if (at === -1) at = list.findIndex((todo) => todo.status === NEXT_STATUS);
  if (at === -1) return null;
  return {
    index: at + 1,
    total: list.length,
    label: clampSummary(list[at].content, TODO_CONTENT_MAX),
  };
}

module.exports = {
  TODO_MAX_ITEMS,
  TODO_CONTENT_MAX,
  slimTodoArguments,
  todoPhaseOf,
};
