'use strict';

/**
 * 守卫：这一组「一轮收尾」的纯模块 —— 停止交代、证据账本与来源、字面核查、步骤摘要、工具组表。
 *
 * 运行：node --test test/phone-turn.test.cjs
 *
 * 这一组全是确定性纯函数，风险都在「口径」上：交代别把失败写成已发送、来源必须指回真实读过
 * 的步且不带正文、核查只核字面别越界、摘要别再调模型。断言围绕这些口径写。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const stopSummary = require('../lib/mobile/phone/stop-summary.js');
const evidence = require('../lib/mobile/phone/evidence.js');
const grounding = require('../lib/mobile/phone/grounding.js');
const stepSummary = require('../lib/mobile/phone/step-summary.js');
const toolGroups = require('../lib/mobile/phone/tool-groups.js');

// ---------- stop-summary ----------

/** 一次被停止的运行的步骤流（直播 / 历史清单形状）。 */
function stoppedRun() {
  return {
    reason: 'aborted',
    steps: [
      { key: 't0', step: { kind: 'think', summary: '先看看余额够不够' } },
      { key: 't1', step: { kind: 'tool', name: 'phone_screen', summary: '银行 App 首页', state: 'ok' } },
      { key: 't2', step: { kind: 'tool', name: 'phone_tap', summary: '付款', state: 'ok', args: { target: '付款' } } },
      { key: 't3', step: { kind: 'tool', name: 'phone_type', summary: '输入金额', state: 'ok', args: { target: '金额' } } },
      { key: 't4', step: { kind: 'tool', name: 'phone_tap', summary: '确认转账', state: 'running', args: { target: '确认转账' } } },
    ],
  };
}

test('停止交代：做了 / 看到 / 对外次数 / 没做完 四段都有', () => {
  const s = stopSummary.summarize(stoppedRun());
  assert.ok(s.done.includes('付款'));
  assert.ok(s.done.includes('输入金额'));
  assert.ok(s.seen.includes('银行 App 首页'));
  assert.equal(s.outward.count, 1);
  assert.equal(s.outward.byKind.payment, 1);
  assert.equal(s.unfinished.length, 1);
  assert.equal(s.unfinished[0].summary, '确认转账');
  assert.equal(s.unfinished[0].state, 'running');
});

test('停止交代：plain 文本收尾明确「没做完」', () => {
  const s = stopSummary.summarize(stoppedRun());
  assert.ok(s.line.includes('对外发出 1 次'));
  assert.ok(s.line.includes('没做完'));
  assert.ok(s.line.endsWith(stopSummary.TAIL));
});

test('继续：给出从哪一步接着做的锚点', () => {
  const c = stopSummary.canContinue(stoppedRun());
  assert.equal(c.ok, true);
  assert.equal(c.anchor.state, 'running');
  assert.equal(c.anchor.summary, '确认转账');
  assert.equal(c.anchor.index, 4);
});

test('没有步骤时不能继续', () => {
  const c = stopSummary.canContinue({ steps: [] });
  assert.equal(c.ok, false);
  assert.equal(c.anchor, null);
});

test('失败的一步算没做完，不算「做了」', () => {
  const s = stopSummary.summarize({
    steps: [{ key: 'x', step: { kind: 'tool', name: 'phone_tap', summary: '提交', state: 'error', args: { target: '提交' } } }],
  });
  assert.equal(s.done.length, 0);
  assert.equal(s.unfinished.length, 1);
  // 失败的动作不计入「对外发出」——没发出去
  assert.equal(s.outward.count, 0);
});

// ---------- evidence ----------

test('账本：截短、去重、可回看', () => {
  const ledger = evidence.createLedger();
  const a = ledger.record({ kind: 'screen', text: '价格 ¥399', place: 'com.shop', step: 2 });
  const b = ledger.record({ kind: 'screen', text: '价格 ¥399', place: 'com.shop', step: 2 });
  assert.equal(ledger.size, 1, '同原文同处只留一条');
  assert.ok(a.id > 0);
  assert.ok(b.id > a.id, '去重后来处更新');
});

test('账本：输出类按头尾截短', () => {
  const ledger = evidence.createLedger();
  const long = 'x'.repeat(evidence.OUTPUT_CHARS + 2000);
  const stored = ledger.record({ kind: 'output', text: long });
  assert.ok(stored.text.length < long.length);
  assert.ok(stored.text.includes('中间省略'));
});

test('账本：脱敏遮住 Key', () => {
  const fakeKey = 'sk-' + 'live_key_abcdefghijklmnop';
  assert.equal(evidence.redactText(`token ${fakeKey} done`), 'token *** done');
});

test('来源：挑出支撑回答的那一条，且只给指针不带正文', () => {
  const ledger = evidence.createLedger();
  const hit = ledger.record({ kind: 'screen', text: '商品页\n价格 ¥399', place: 'com.shop', step: 2, mediaIds: [7] });
  ledger.record({ kind: 'web', text: '天气预报 晴', place: 'weather.com', step: 3 });
  const sources = evidence.selectSources('这个 ¥399 可以下单。', ledger);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].obsId, hit.id);
  assert.equal(sources[0].step, 2);
  assert.deepEqual(sources[0].mediaIds, [7]);
  // 只给指针：没有正文字段
  assert.equal('text' in sources[0], false);
});

test('来源：一条都对不上时退回最后一条观察', () => {
  const ledger = evidence.createLedger();
  ledger.record({ kind: 'screen', text: '打开了设置页', place: 'com.android.settings', step: 1 });
  const sources = evidence.selectSources('已完成。', ledger);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].obsId, 1);
});

test('来源：至多 6 处', () => {
  const ledger = evidence.createLedger();
  for (let i = 0; i < 10; i += 1) ledger.record({ kind: 'screen', text: `价格 ¥${400 + i}`, place: 'com.shop', step: i });
  const sources = evidence.selectSources('价格 ¥409。', ledger);
  assert.ok(sources.length <= evidence.MAX_SOURCES);
});

// ---------- grounding ----------

test('核查：带货币的数在材料里 → 通过', () => {
  const r = grounding.check({ answer: '价格是 ¥399。', evidence: ['商品页\n价格 ¥399'] });
  assert.equal(r.ok, true);
  assert.equal(r.unmet.length, 0);
});

test('核查：数对不上 → 不通过并给改写提示', () => {
  const r = grounding.check({ answer: '价格是 ¥399。', evidence: ['价格 ¥499'] });
  assert.equal(r.ok, false);
  assert.equal(r.unmet[0].kind, 'number');
  const hint = grounding.rewriteHint(r);
  assert.ok(hint.includes('399'));
  assert.ok(hint.includes('改写一次'));
});

test('核查：引文在材料里 → 通过；不在 → 不通过', () => {
  const ok = grounding.check({ answer: '页面写着「包邮到家」。', evidence: ['商品说明：包邮到家'] });
  assert.equal(ok.ok, true);
  const bad = grounding.check({ answer: '页面写着「七天无理由」。', evidence: ['商品说明：包邮到家'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.unmet[0].kind, 'quote');
});

test('核查：日期在材料里 → 通过', () => {
  const r = grounding.check({ answer: '活动到 10月23日 截止。', evidence: ['活动截止 10月23日 23:59'] });
  assert.equal(r.ok, true);
});

test('核查：两位以内不带单位的整数不核', () => {
  const r = grounding.check({ answer: '一共 3 步。', evidence: ['别的内容'] });
  assert.equal(r.ok, true);
});

test('改写口径：第一次退回改写，改过再不过就标未确认', () => {
  const input = { answer: '价格是 ¥399。', evidence: ['价格 ¥499'] };
  const first = grounding.review(input);
  assert.equal(first.action, 'rewrite');
  const again = grounding.review({ ...input, alreadyRewritten: true });
  assert.equal(again.action, 'unconfirmed');
});

// ---------- step-summary ----------

test('步骤摘要：五段齐全、确定性', () => {
  const steps = [];
  for (let i = 0; i < 18; i += 1) {
    steps.push({ key: `s${i}`, step: { kind: 'tool', name: 'phone_tap', summary: `第 ${i} 步`, state: 'ok' } });
  }
  steps.push({ key: 'r', step: { kind: 'tool', name: 'read', summary: '/a/b.txt', state: 'ok', args: { file_path: '/a/b.txt' } } });
  steps.push({ key: 'k', step: { kind: 'think', summary: '准备收尾' } });
  const s = stepSummary.summarizeSteps(steps, { goal: '把设置改好' });
  assert.equal(s.goal, '把设置改好');
  assert.ok(Array.isArray(s.facts['读写的文件']));
  assert.ok(s.facts['读写的文件'].includes('/a/b.txt'));
  assert.equal(s.progress.length, stepSummary.MAX_PROGRESS);
  assert.ok(Object.keys(s.earlier).length >= 1, '更早的步骤并成结局计数');
  assert.equal(s.intent, '准备收尾');
  const text1 = s.render();
  const text2 = stepSummary.summarizeSteps(steps, { goal: '把设置改好' }).render();
  assert.equal(text1, text2, '同一历史两次摘要必须一致（前缀稳）');
  assert.ok(text1.includes('目标：把设置改好'));
  assert.ok(text1.includes('已确认：'));
  assert.ok(text1.includes('进展：'));
  assert.ok(text1.includes('下一步：'));
});

test('步骤摘要：事实按种类去重且有上限', () => {
  const steps = [];
  for (let i = 0; i < 10; i += 1) {
    steps.push({ key: `w${i}`, step: { kind: 'tool', name: 'write', summary: '写文件', state: 'ok', args: { file_path: `/f/${i}.txt` } } });
  }
  const s = stepSummary.summarizeSteps(steps, { goal: 'x' });
  assert.ok(s.facts['读写的文件'].length <= stepSummary.MAX_FACT_VALUES);
  // 去重：同样的路径只留一份
  const dup = stepSummary.summarizeSteps([
    { step: { kind: 'tool', name: 'read', state: 'ok', args: { file_path: '/same.txt' } } },
    { step: { kind: 'tool', name: 'read', state: 'ok', args: { file_path: '/same.txt' } } },
  ], { goal: 'x' });
  assert.deepEqual(dup.facts['读写的文件'], ['/same.txt']);
});

// ---------- tool-groups ----------

test('工具组：折叠时只给启用组的入口短说明', () => {
  const notes = toolGroups.entryNotesFor(['phone_screen', 'phone_tap']);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].group, 'phone');
  assert.ok(notes[0].note.length > 0);
  // 展开后不再给入口短说明
  const expanded = toolGroups.entryNotesFor(['phone_screen', 'phone_tap'], ['phone']);
  assert.equal(expanded.length, 0);
});

test('工具组：能力段按工具门控', () => {
  const ids = toolGroups.capabilitiesFor(['phone_screen']).map((c) => c.id);
  assert.ok(ids.includes('general'));
  assert.ok(ids.includes('phone'));
  assert.equal(ids.includes('web'), false);
});
