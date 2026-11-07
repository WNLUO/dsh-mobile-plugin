'use strict';

/**
 * 不可逆动作判定：纯函数，只回答「这一下点下去是不是收不回来」，不做任何动作。
 *
 * 给 tools 层做单步提示、给 batch 做熔断用。判据刻意窄：只有 **tap** 且能读到「点的是哪个
 * 按钮的文字」才算数。读不到文字（只有 ref、只有坐标而没 target）就判不了，宁可放过也不
 * 误判 —— 把整屏文字当成这一下的目标，会把「聊天页里恰好有『删除』两个字」判成删除，
 * 那比漏判更烦人（每次点都停下来问）。
 *
 * 词表繁简两边都认，加上英文的 send / submit / order / pay / buy / delete。分成五类，
 * 但输出的 kind 只有 payment / submit / send / delete / none —— 下单、购买、付款这类收钱的
 * 都归 payment（对熔断来说它们是一回事：都花钱）。
 *
 * 已知局限：这是词表兜底，不看语义。订单状态一类的文字（「待付款」「付款成功」「订单记录」）
 * 里也有付款 / 订单词，会被当成对外动作 —— 方向是「宁可多停一次」，不会误执行。
 */

/** 只有点屏幕才有「点的是哪个按钮」这回事。 */
const TAP_ACTIONS = new Set(['tap']);

/**
 * 词表按 kind 分组，顺序即优先级：先看样子最重的付款 / 下单，再提交、发送、删除。
 * 中文按包含判；纯英文词按单词边界判，免得 order 在 reorder、delete 在 undelete 里误命中。
 */
const WORD_TABLE = [
  {
    kind: 'payment',
    words: [
      '支付', '付款', '买单', '买單', '下单', '下單', '购买', '購買',
      '结算', '結算', '订单', '訂單', '收银台', '收銀台',
      'pay', 'payment', 'order', 'buy', 'purchase', 'checkout',
    ],
  },
  {
    kind: 'submit',
    words: ['提交', '确认提交', '確認提交', '送出', 'submit'],
  },
  {
    kind: 'send',
    words: ['发送', '傳送', '传送', '发布', '發布', '发表', '發表', 'send', 'post'],
  },
  {
    kind: 'delete',
    words: ['删除', '刪除', '清空', '移除', 'delete', 'remove', 'clear'],
  },
];

/** 这些字段可能装着「点的是哪个按钮」的文字；按顺序取，取到非空就用。 */
const LABEL_FIELDS = [
  'text', 'target', 'label', 'name', 'description', 'desc',
  'contentDescription', 'title', 'content', 'value',
];

function isEnglishWord(word) {
  return /^[a-z]+$/.test(word);
}

/** 在一个文字里找第一个命中的词，返回 {kind, word} 或 null。 */
function matchLabel(label) {
  const lower = label.toLowerCase();
  for (const group of WORD_TABLE) {
    for (const word of group.words) {
      if (isEnglishWord(word)) {
        // 英文按整词匹配，避免 order 命中 reorder / preorder。
        if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) return { kind: group.kind, word };
      } else if (label.includes(word)) {
        return { kind: group.kind, word };
      }
    }
  }
  return null;
}

/** 从参数里能读到的、像「被点元素文字」的那几条。 */
function labelsOf(args) {
  const out = [];
  for (const key of LABEL_FIELDS) {
    const value = args[key];
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/** 一个孤零零的短串才可能是按钮文字；长段多行的是整屏，不能当目标。 */
function looksLikeLabel(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 32) return false;
  return !/[\r\n]/.test(trimmed);
}

function none(reason) {
  return { irreversible: false, kind: 'none', reason };
}

/**
 * judge({ action, args, screenText }) → { irreversible, kind, reason }。
 *
 * `screenText` 只在「既没 ref / 坐标、也没有任何文字字段」且它本身像个按钮短串时才当目标文字；
 * 有 ref 或坐标却没有文字时一律判不了 —— 这是「ref 点按不误判」那条要求的落点。
 */
function judge(input) {
  const { action, args, screenText } = input || {};
  const a = args && typeof args === 'object' ? args : {};

  if (typeof action !== 'string' || !TAP_ACTIONS.has(action)) {
    return none('只判 tap：别的动作没有「点的是哪个按钮」这回事');
  }

  const hasRef = typeof a.ref === 'string' && a.ref.trim() !== '';
  const hasPoint = Number.isFinite(a.x) && Number.isFinite(a.y);
  let labels = labelsOf(a);

  if (labels.length === 0) {
    if (hasRef || hasPoint) {
      return none('只有 ref / 坐标、没有说话文字，判定不了');
    }
    if (typeof screenText === 'string' && looksLikeLabel(screenText)) {
      labels = [screenText.trim()];
    }
  }

  if (labels.length === 0) return none('没有可判的文字');

  for (const label of labels) {
    const hit = matchLabel(label);
    if (hit) {
      return {
        irreversible: true,
        kind: hit.kind,
        reason: `「${label}」命中不可逆词「${hit.word}」`,
      };
    }
  }
  return none('没有命中不可逆词表');
}

module.exports = {
  judge,
  // 下面几个给守卫直接用真值表，不重复实现匹配逻辑。
  WORD_TABLE,
  matchLabel,
};
