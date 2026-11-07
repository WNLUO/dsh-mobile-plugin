'use strict';

/**
 * 付款/不可逆动作的「申报 → 同意 → 单次放行」闸门：纯逻辑，无 IO，不读屏、不推卡。
 *
 * ## 为什么要有它
 *
 * 现在「用户同意一次」放行的是任意下一步：用户看着「给张三发一句你好」点了同意，模型下一步
 * 换成「给李四转账」也照放 —— 这就是批里掉包。Mika 的 `ConfirmationGate.kt` 把同意**绑死在
 * 申报内容**上：同一 App、同类动作、目标出现在屏上、要发的字逐字相等、应付金额在屏上，五条
 * 同时成立才放行，且只放行紧接着的那一个匹配操作；中间做了别的写操作、或过了 3 步，同意作废。
 * 这里把这套规则搬成纯 JS。
 *
 * ## 谁做什么
 *
 * 本模块只管逻辑：模型申报（`declare`）、用户同意（`approve` / `reject`）、拿一步来核（`check`）、
 * 作废（`invalidate`）、看状态（`state`）。**审批卡推不推、走哪条审批桥、拿到什么结论，都由调用方决定** ——
 * 我们复用宿主已有的 `approval/request`（见 `confirm.js`），不新开裁决路。调用方在拿到
 * `allowed-once` 后调 `approve(stepIndex)` 把这份同意立起来，之后每一步写操作前调 `check(...)`。
 *
 * ## 一句话记住的规则
 *
 * - 同意只放行「紧接着的一个」匹配操作；`check` 一核就把这份同意用掉，不论最后是放行还是对不上。
 * - 对不上、超 3 步、换了 App / 动作 / 目标 / 文字 / 金额，一律 `mismatch`，不执行。
 * - **付款永远不放行**：`check` 碰到付款动作返回 `takeover`（交给人接管），不是 `allowed`。
 *
 * 与 Mika 的差别（我们只有扁平文字，没有元素树与 bounds）：发送对象的「标题栏位置」这一条
 * 退化成「目标文字出现在整屏文字里」；金额也从「可滚动区内外、离按钮最近」退化成「带币种的
 * 应付金额出现在整屏文字里」。其余四条（同 App、同动作、逐字相等、单次/过期）原样保留。
 */

const { matchLabel, payableAmounts, hasTotalLabel } = require('./irreversible.js');

/** 同意后过了这么多步还没用到就作废。 */
const MAX_STEPS = 3;

/** 目标文字比对只看前这么多字，避免长段落整段比。 */
const MATCH_CHARS = 20;

/** 模型/调用方用的语义动作 → 本模块的分类。 */
const ACTION_KIND = {
  pay: 'pay', 支付: 'pay', 付款: 'pay',
  order: 'order', buy: 'order', purchase: 'order', checkout: 'order', 下单: 'order', 购买: 'order', 結算: 'order', 结算: 'order',
  send: 'send', 发送: 'send', 发布: 'send', 发表: 'send', post: 'send',
  submit: 'submit', 提交: 'submit',
  delete: 'delete', 删除: 'delete', 清空: 'delete', remove: 'delete',
  change: 'change', 其他: 'other', other: 'other',
};

function norm(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, '').toLowerCase() : '';
}

/** 从 target 里判是哪一类动作（拿不到语义动作名时用）。 */
function kindFromTarget(target) {
  const hit = target ? matchLabel(target) : null;
  if (!hit) return 'other';
  if (hit.kind === 'payment') {
    // 支付/付款/买单/收银 是「付款」（永不自动放行），下单/购买/结算/订单 是「下单」（可按金额放行）。
    return /支付|付款|买单|收银|转账/.test(target) ? 'pay' : 'order';
  }
  if (hit.kind === 'send') return 'send';
  if (hit.kind === 'submit') return 'submit';
  if (hit.kind === 'delete') return 'delete';
  return 'other';
}

/** 语义动作 → 分类；语义名认不出就回落到按 target 判。 */
function declarationKind(action, target) {
  const name = typeof action === 'string' ? action.trim().toLowerCase() : '';
  // irreversible.js 把「付款」和「下单」都归成 payment；gate 需要分开（付款永不自动放行、
  // 下单可按金额放行），所以拿到 payment 时按目标文字再分一次。
  if (name === 'payment') return kindFromTarget(target);
  if (ACTION_KIND[name]) return ACTION_KIND[name];
  return kindFromTarget(target);
}

function numOf(text) {
  const m = String(text == null ? '' : text).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function createGate() {
  /** 等用户表态的申报单。 */
  let pending = null;
  /** 用户已同意、还没用掉的那一次：{ declaration, step }。 */
  let grant = null;
  /** 用户拒过的同类操作（同类动作 + 同一 App），不再问。 */
  const declined = new Set();
  let lastDecision = null;

  function record(decision) {
    lastDecision = decision;
    return decision;
  }

  /** 把外部传入的申报整理成一份干净的申报单。 */
  function snapshot(input) {
    const src = input && typeof input === 'object' ? input : {};
    const app = typeof src.app === 'string' ? src.app.trim() : '';
    const target = typeof src.target === 'string' ? src.target.trim() : '';
    const amountText = typeof src.amountText === 'string' ? src.amountText.trim() : '';
    const textToSend = typeof src.textToSend === 'string' ? src.textToSend : null;
    const rawAction = typeof src.action === 'string' ? src.action.trim() : '';
    return {
      app, target, amountText, textToSend, rawAction,
      action: declarationKind(rawAction, target),
    };
  }

  /**
   * 模型主动申报一份要确认的操作。生成申报单并挂起，等用户表态（由调用方推卡、拿结论）。
   * @returns {{status:'pending'|'declined'|'invalid', declaration?:object, reason?:string}}
   */
  function declare(input) {
    const d = snapshot(input);
    if (!d.app || (!d.rawAction && !d.target)) {
      record({ decision: 'invalid', reason: '申报缺少 App 或动作/目标' });
      return { status: 'invalid', reason: '申报缺少 App 或动作/目标' };
    }
    if (declined.has(`${d.action}|${d.app}`)) {
      record({ decision: 'declined', reason: `用户已拒绝过 ${d.app} 上的同类操作` });
      return { status: 'declined', declaration: d, reason: '这一 App 上的同类操作用户已拒绝过，不再问' };
    }
    pending = d;
    record({ decision: 'pending' });
    return { status: 'pending', declaration: d };
  }

  /**
   * 用户同意：把挂起的申报单立成一次性同意（由调用方拿到 `allowed-once` 后调用）。
   * @param {number} [stepIndex] 同意发生在第几步（过期按它算）
   */
  function approve(stepIndex) {
    const step = Number.isFinite(stepIndex) ? stepIndex : 0;
    if (!pending) return { status: 'no-pending' };
    const declaration = pending;
    pending = null;
    grant = { declaration, step };
    record({ decision: 'granted', declaration });
    return { status: 'granted', declaration };
  }

  /** 用户拒绝：记下这一类，同类同 App 的申报以后直接 declined，不再打扰。 */
  function reject() {
    if (!pending) return { status: 'no-pending' };
    const declaration = pending;
    pending = null;
    declined.add(`${declaration.action}|${declaration.app}`);
    record({ decision: 'rejected', declaration });
    return { status: 'rejected', declaration };
  }

  /**
   * 拿即将执行的这一步来核。核完这份同意就用掉（不论结果），保证「一份同意只放行一步」。
   *
   * @param {object} input
   * @param {string} input.app         当前前台包名
   * @param {string} [input.action]    这一步的语义动作（tap/type/send/order/pay…）；缺省时按 target 判
   * @param {string} [input.target]    这一步作用的文字
   * @param {string} [input.screenText] 当前整屏文字
   * @param {number} [input.stepIndex]  当前步数
   * @param {string} [input.textToSend] 这一步实际要发出/输入的文字（发送类必填，用来逐字比）
   * @returns {{decision:'allowed'|'takeover'|'mismatch'|'no-grant', reason?:string}}
   */
  function check(input) {
    const src = input && typeof input === 'object' ? input : {};
    const app = typeof src.app === 'string' ? src.app.trim() : '';
    const target = typeof src.target === 'string' ? src.target.trim() : '';
    const screenText = typeof src.screenText === 'string' ? src.screenText : '';
    const step = Number.isFinite(src.stepIndex) ? src.stepIndex : 0;
    const textToSend = typeof src.textToSend === 'string' ? src.textToSend : null;
    const currentKind = declarationKind(src.action, target);

    // 付款永不自动放行：只走接管；顺手把可能挂着的同意作废掉，免得它被后一步误用。
    if (currentKind === 'pay') {
      grant = null;
      return record({ decision: 'takeover', reason: '付款永不自动放行，交给人接管' });
    }
    if (!grant) {
      return record({ decision: 'no-grant', reason: '没有可用的同意' });
    }

    // 有同意就只这一次：先取走，再判，无论对错都不留。
    const used = grant;
    grant = null;
    const d = used.declaration;

    // 申报本身是付款：同样只走接管。
    if (d.action === 'pay') {
      return record({ decision: 'takeover', reason: '申报的是付款，只走接管' });
    }

    const reason = firstMismatch(d, currentKind, app, target, screenText, textToSend, step, used.step);
    if (reason) return record({ decision: 'mismatch', reason });
    return record({ decision: 'allowed' });
  }

  /** 五条同时成立才放行；返回第一条不成立的理由，全成立返回 null。 */
  function firstMismatch(d, currentKind, app, target, screenText, textToSend, step, grantStep) {
    if (step - grantStep > MAX_STEPS) return `同意已过期（超过 ${MAX_STEPS} 步）`;
    if (d.action !== currentKind) return `申报的是 ${d.action}，这一步是 ${currentKind}`;
    if (!app || app !== d.app) return `申报在 ${d.app || '(无)'}，屏上却是 ${app || '(读不到)'}`;
    if (!targetShown(d.target, screenText)) return `申报的目标「${d.target}」不在屏上`;
    if (d.action === 'send' && !contentMatches(d.textToSend, textToSend)) {
      return `要发的字与申报不逐字相等`;
    }
    if (amountBinds(d.action, screenText) && !amountShown(d.amountText, screenText)) {
      return `申报的金额「${d.amountText || '(无)'}」没有在屏上对上`;
    }
    return null;
  }

  /** 申报的目标出现在整屏文字里（去空白、不区分大小写，至少两个字，比前 MATCH_CHARS 字）。 */
  function targetShown(target, screenText) {
    const t = norm(target).slice(0, MATCH_CHARS);
    if (t.length < 2) return false;
    return norm(screenText).includes(t);
  }

  /** 要发的字逐字相等；申报被截短（以 … 结尾）时比前缀。 */
  function contentMatches(declaredText, actualText) {
    if (typeof declaredText !== 'string' || typeof actualText !== 'string') return false;
    const capped = declaredText.endsWith('…');
    const declared = norm(declaredText.replace(/…$/, ''));
    const actual = norm(actualText);
    return capped ? actual.startsWith(declared) : actual === declared;
  }

  /** 金额是否参与这次核对：下单/付款始终要；提交/删除只在屏上有合计类字样时要；发送不要。 */
  function amountBinds(kind, screenText) {
    if (kind === 'order' || kind === 'pay') return true;
    if (kind === 'submit' || kind === 'delete') return hasTotalLabel(screenText);
    return false;
  }

  /** 屏上有一个带币种的应付金额等于申报金额（优惠金额已被 payableAmounts 排除）。 */
  function amountShown(amountText, screenText) {
    const want = numOf(amountText);
    if (want === null) return false;
    return payableAmounts(screenText).some((value) => value === want);
  }

  /**
   * 显式把「刚放行的这一步已经执行了」记下来。因为 `check` 一核就自动用掉同意，正常流程里这
   * 里通常已经没有可用的同意；留着它是给调用方一个明确的收尾口子（也方便审计）。
   * @returns {{consumed:boolean, declaration?:object}}
   */
  function consume() {
    if (!grant) return { consumed: false };
    const declaration = grant.declaration;
    grant = null;
    return { consumed: true, declaration };
  }

  /**
   * 作废：做了别的写操作（点了别处、滑了、返回、开了别的 App）就调它。只清掉已立起的同意，
   * 不动还没表态的申报单（那份还没被同意，谈不上作废）。
   */
  function invalidate() {
    const had = Boolean(grant);
    grant = null;
    return { invalidated: had };
  }

  /** 当前状态快照（拷贝，外部改不到内部）。 */
  function state() {
    return {
      pending: pending ? { ...pending } : null,
      grant: grant ? { declaration: { ...grant.declaration }, step: grant.step } : null,
      declined: [...declined],
      lastDecision,
    };
  }

  return { declare, approve, reject, check, consume, invalidate, state };
}

module.exports = {
  createGate,
  MAX_STEPS,
  MATCH_CHARS,
  // 下面几个导出给守卫单独钉规则，不必经 createGate。
  declarationKind,
  amountBinds: (kind, screenText) => {
    if (kind === 'order' || kind === 'pay') return true;
    if (kind === 'submit' || kind === 'delete') return hasTotalLabel(screenText);
    return false;
  },
};
