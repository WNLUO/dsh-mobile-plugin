'use strict';

/**
 * 动作风险五级分级：纯函数，只回答「这一步大概会造成多大影响」，不做任何动作、不读屏。
 *
 * 从 Mika（`core/action/Approval.kt` 的 `ActionRisk`）借五级口径：
 *
 *   Read          只看，或只在界面间移动（读屏、等、开/关 App、返回）
 *   Change        在界面上改东西（点、打字、滑、手势、按键），改的是界面不是世界
 *   External      把东西交给别人（发送、发布、提交），会影响屏外的世界
 *   Irreversible  做了收不回（付款、下单、删除）
 *   Unknown       看不清点的是什么，按拿不准处理
 *
 * `outward`（影响屏幕之外的世界，或拿不准会不会）对 External / Irreversible / Unknown 为真，
 * 用来决定「这一步要不要记账、要不要人工确认」。这份分级只给调用方做参考：真正的放行/接管
 * 判定在 gate.js 里，risk 不碰任何状态。
 *
 * 我们对 Mika 的取舍：Mika 分级要读整屏快照，能按资源 ID、组合键、弹框、拖拽等信号判；
 * 我们的输入只有「动作名 + 目标文字 + 是否对外」这一份结构化信息，所以分级只用到这三样，
 * 判不准的一律落到 Unknown，不猜。
 */

const { matchLabel } = require('./irreversible.js');

/** 只看、只在界面间移动，不改屏外的世界。 */
const READ_ACTIONS = new Set([
  'screen.read', 'read', 'screenshot', 'list', 'find', 'wait',
  'scroll', 'app.open', 'app.close', 'back', 'home', 'recents', 'tab',
]);

/** 在界面上改东西。 */
const CHANGE_ACTIONS = new Set(['tap', 'type', 'swipe', 'key', 'gesture', 'clear', 'clear_text', 'long_press']);

/** 点按类：读不到目标文字时判不了点的是什么。 */
const TAP_LIKE = new Set(['tap', 'long_press']);

function result(level, outward, why) {
  return { level, outward, why };
}

/**
 * classify({ action, target, outward }) → { level, outward, why }
 *
 * @param {object} input
 * @param {string} input.action   动作名（tap / type / swipe / key / app.open / screen.read …）
 * @param {string} [input.target] 这一下作用的文字（按钮名、发送对象、输入框标签…）
 * @param {boolean} [input.outward] 调用方已经知道这一步对外（如带回车的打字、提交式点击）时置 true
 * @returns {{level:string, outward:boolean, why:string}}
 */
function classify(input) {
  const src = input && typeof input === 'object' ? input : {};
  const action = typeof src.action === 'string' ? src.action.trim().toLowerCase() : '';
  const target = typeof src.target === 'string' ? src.target.trim() : '';
  const outwardFlag = src.outward === true;

  if (!action) return result('Unknown', true, '没有动作名，判不了这一步做什么');

  if (READ_ACTIONS.has(action)) {
    return result('Read', false, `${action} 只看或只在界面间移动，不改屏外的东西`);
  }

  if (!CHANGE_ACTIONS.has(action)) {
    return result('Unknown', true, `不认识的动作「${action}」，按拿不准处理`);
  }

  // 目标文字能命中不可逆词表：按命中的类别定级。
  const hit = target ? matchLabel(target) : null;
  if (hit) {
    if (hit.kind === 'payment') {
      return result('Irreversible', true, `「${target}」是付款/下单一类，做了收不回`);
    }
    if (hit.kind === 'delete') {
      return result('Irreversible', true, `「${target}」是删除一类，做了收不回`);
    }
    return result('External', true, `「${target}」会把东西交给别人（${hit.kind}）`);
  }

  // 调用方已经声明这一步对外（例如带回车的打字）。
  if (outwardFlag) {
    return result('External', true, `${action} 被声明为对外动作，会影响屏外的世界`);
  }

  // 点按类却读不到目标文字：看不清点的是什么。
  if (TAP_LIKE.has(action) && !target) {
    return result('Unknown', true, '点按但读不到目标文字，看不清点的是什么');
  }

  return result('Change', false, `${action} 只在界面上改动，不涉及屏外的世界`);
}

module.exports = {
  classify,
  READ_ACTIONS,
  CHANGE_ACTIONS,
};
