'use strict';

/**
 * 不可逆动作判定：纯函数，只回答「这一下点下去是不是收不回来」，不做任何动作。
 *
 * 给 tools 层做单步提示、给 batch 做熔断用。判据刻意窄：只有 **tap** 且能读到「点的是哪个
 * 按钮的文字」才算数。读不到文字（只有 ref、只有坐标而没 target）就判不了，宁可放过也不
 * 误判 —— 把整屏文字当成这一下的目标，会把「聊天页里恰好有『删除』两个字」判成删除，
 * 那比漏判更烦人（每次点都停下来问）。
 *
 * ## 从 Mika 借来的三条判据（词表与阈值按我们自己的口径重定，没有照抄）
 *
 * 1. **订单状态不算动作。** 词前面紧挨着「待」「已」、或后面跟着状态/入口一类的尾巴
 *    （成功、记录、明细、方式、列表、中心、入口、码、售后），这条词就不是一个可点的动作，
 *    而是状态或入口：`待付款`、`付款成功`、`订单记录`、`付款方式` 一律不算。我们只认
 *    「这一下点下去会改世界」的那种写法，宁可漏判一次也不把每个列表页都拦下来。
 * 2. **优惠金额不算应付金额。** 紧挨着 优惠 / 减 / 抵扣 / 运费 / 券 / 红包 / 已省（或前面带
 *    负号）的金额不参与金额核对；否则「满25减3」会被当成「应付 25」。
 * 3. **金额与合计识别单列出来。** `payableAmounts` / `hasTotalLabel` / `TOTAL_LABELS` 给
 *    gate 核对「申报的金额在屏上」用；只有合计/实付/应付/总计/总价/小计/总额这类字样，或带
 *    币种/元的数，才算金额。单独一个价格、待遇、区间不是应付金额。
 *
 * 与 Mika 的差别：Mika 的 `IrreversibleDetector.kt` 六百多行，认回车/组合键/横滑/资源 ID/
 * 下拉/拖拽/看图找点等十几种信号；我们只有 tap 的那一条路，其余信号在手机执行器里由
 * `ScreenTree` 压平后本来就拿不到。所以这里只搬规则、不搬那六百行：状态前缀/后缀、优惠排除、
 * 合计识别这三条最容易被误判的补进来，词表仍用我们自己那份（下单、购买、付款、发送、提交、
 * 删除等），阈值（状态尾巴、优惠窗口、英文整词）都按上面重定。
 *
 * 输出的 kind 仍只有 payment / submit / send / delete / none —— 下单、购买、付款这类收钱的
 * 都归 payment（对熔断来说它们是一回事：都花钱）。
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

/** 紧挨在词前面时，说明它是一个状态而不是动作：「待付款」「已付款」。 */
const STATUS_PREFIXES = new Set(['待', '已']);

/** 紧跟在词后面（跳过标点后）时，说明它是状态或入口：「付款成功」「订单记录」「付款方式」。 */
const STATUS_SUFFIXES = ['成功', '记录', '明细', '方式', '列表', '中心', '入口', '码', '售后'];

/** 合计一类的字样：这后面的数才是应付金额。 */
const TOTAL_LABELS = ['合计', '实付', '应付', '总计', '总价', '小计', '总额', '待付款金额'];

/** 紧挨在金额前面的优惠一类字样：这类金额不是应付金额。 */
const DISCOUNTS = ['优惠', '减', '抵扣', '运费', '券', '红包', '已省'];
/** 往前看几个字判断是不是优惠金额。 */
const DISCOUNT_WINDOW = 4;

/** 带币种（¥/￥/$/＄）或「元」的金额；小数允许 . 或 , 作分隔。 */
const CURRENCY = /[¥￥$＄]\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*元/g;

function isEnglishWord(word) {
  return /^[a-z]+$/.test(word);
}

/** 去掉标点后的后续文字，用来判状态尾巴。 */
function afterWord(text, end) {
  return text.slice(end).replace(/^[^\p{L}\p{N}]+/u, '');
}

/** 这一处词是不是一个「动作」，而不是状态/入口（见文件头第 1 条）。 */
function isActionOccurrence(label, word, index) {
  if (index > 0 && STATUS_PREFIXES.has(label[index - 1])) return false;
  const rest = afterWord(label, index + word.length);
  return !STATUS_SUFFIXES.some((suffix) => rest.startsWith(suffix));
}

/** 在一个文字里找第一个命中的词，返回 {kind, word} 或 null。 */
function matchLabel(label) {
  const lower = label.toLowerCase();
  for (const group of WORD_TABLE) {
    for (const word of group.words) {
      if (isEnglishWord(word)) {
        // 英文按整词匹配，避免 order 命中 reorder / preorder。
        if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) return { kind: group.kind, word };
        continue;
      }
      // 中文可能有多个出现位置，逐个判是不是动作（跳过「待付款」「付款成功」这类）。
      let from = 0;
      let index = label.indexOf(word, from);
      while (index !== -1) {
        if (isActionOccurrence(label, word, index)) return { kind: group.kind, word };
        from = index + 1;
        index = label.indexOf(word, from);
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
 * 从一段文字里认出带币种/元的金额（去掉优惠一类、带负号的）。给 gate 核对金额用。
 * @returns {number[]} 数字数组
 */
function payableAmounts(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  CURRENCY.lastIndex = 0;
  let m;
  while ((m = CURRENCY.exec(text)) !== null) {
    const raw = (m[1] || m[2] || '').replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const before = text.slice(Math.max(0, m.index - DISCOUNT_WINDOW), m.index);
    if (DISCOUNTS.some((w) => before.includes(w))) continue;
    if (before.trimEnd().endsWith('-')) continue;
    out.push(value);
  }
  return out;
}

/** 这段文字里有没有「合计/实付/应付/总计…」这类字样（金额核对是否绑定用它）。 */
function hasTotalLabel(text) {
  if (typeof text !== 'string' || !text) return false;
  return TOTAL_LABELS.some((label) => text.includes(label));
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
  // 下面几个给守卫和 gate 直接用真值表，不重复实现匹配逻辑。
  WORD_TABLE,
  matchLabel,
  payableAmounts,
  hasTotalLabel,
  TOTAL_LABELS,
};
