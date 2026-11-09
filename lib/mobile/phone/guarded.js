'use strict';

/**
 * 「只能用户本人操作」的界面判据：纯函数，只回答「这一屏该不该由 AI 自己点」，不执行任何动作。
 *
 * 判据两条，命中任意一条就算：
 * - **包名**：系统设置、权限控制器、还有我们这个 App 自己。前两个的每个开关都动的是整机行为，
 *   我们这个自己点自己等于让 AI 改自己的开关，都该由用户伸手。
 * - **文字**：屏幕上出现「隐私、权限、授权、无障碍、账号安全、指纹、面容、免密支付」这类词。
 *   口径是「这一下会改隐私/安全设置」，不是「这一屏提到安全」—— 所以只收动词性/开关性的词，
 *   普通列表页里出现的「隐私政策」「权限说明」链接不在词表里，免得每次点网页都把 AI 拦下来。
 *
 * 命中后宿主**硬拒并让用户自己来**，不是发一张审批卡：审批卡的语义是「你同意我代你做」，
 * 而这里要的是「这件事没有代做这一说」。所以它不进 `confirm.needsConfirmation`，也不进
 * `irreversible.judge` 的那套词表 —— 判据独立成模块，与原生那份（点之前先问壳）同一口径。
 *
 * 能力面没变：这里只做拒绝，没有新增任何「能碰什么」的能力。
 */

/**
 * 必须用户本人操作的包。设置改整机行为；权限控制器决定别的 App 能不能用敏感能力；
 * 本机 App 自己（含 debug 变体）在里面能改的是 AI 自己的开关。
 */
const GUARDED_PACKAGES = new Set([
  'com.android.settings',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.dsh.mobile',
  'com.dsh.mobile.debug',
]);

/**
 * 会改隐私 / 安全设置的界面用词。按包含判（中文词没有词边界可言）。
 * 只收「点下去会动开关」的词：政策、说明、文档这类只是展示的链接不收。
 */
const GUARDED_WORDS = [
  '隐私',
  '权限',
  '授权',
  '无障碍',
  '辅助功能',
  '账号安全',
  '账户安全',
  '安全中心',
  '指纹',
  '面容',
  '人脸',
  '免密支付',
  '自动扣款',
  '解除绑定',
  '注销账号',
  '设备管理',
];

/** 命中的第一个词，供 reason 说明「因为屏上有这个词」。 */
function firstHit(texts) {
  if (!Array.isArray(texts)) return '';
  for (const raw of texts) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text) continue;
    for (const word of GUARDED_WORDS) {
      if (text.includes(word)) return word;
    }
  }
  return '';
}

/**
 * 这一屏算不算「只能用户本人操作」。
 *
 * @param {string} packageName 当前前台包名（可空）
 * @param {string[]} [texts] 这一屏上读得到的文字（可空；不传等于只按包名判）
 * @returns {{guarded:true, reason:string}|null} 命中给理由，不命中给 null
 */
function guardedTarget(packageName, texts) {
  const pkg = typeof packageName === 'string' ? packageName.trim() : '';
  if (pkg && GUARDED_PACKAGES.has(pkg)) {
    return { guarded: true, reason: '系统设置/隐私相关界面' };
  }
  const word = firstHit(texts);
  if (word) return { guarded: true, reason: `屏上是隐私/安全相关的设置（${word}）` };
  return null;
}

module.exports = { GUARDED_PACKAGES, GUARDED_WORDS, guardedTarget };
