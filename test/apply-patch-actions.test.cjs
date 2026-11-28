'use strict';

/**
 * `apply_patch` 在手机端的两处「按路径说话」：过程清单的一行摘要、审批卡的事实行。
 *
 * 宿主从 0.2.3 起默认把这个工具摆到模型面前，它一次改好几个文件、参数里没有单个
 * `file_path`，路径写在补丁头里。不认补丁头的后果是静默的：清单那一行只剩工具名（用户
 * 看不出它要动哪些文件），审批卡干脆不出事实行（用户不知道自己在批什么）。
 *
 * 这两处都由 `lib/mobile/patch-files.js` 读补丁头，本脚本钉住它的口径：
 *   §1 摘要：前三份就够，多了说个数
 *   §2 审批卡：一份就写名字，多份写「等 N 个文件」，类别键按目录归
 *   §3 认不出来就不编（摘要退回描述、审批卡不出事实行）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { toolStepSummary } = require('../lib/mobile/step-index.js');
const facts = require('../lib/mobile/approval-facts.js');
const { patchFilePaths } = require('../lib/mobile/patch-files.js');

const CWD = '/repo';

/** 一份改四个文件、外加一次删除的补丁。 */
const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  '-old',
  '+new',
  '*** Add File: src/b.ts',
  '+hello',
  '*** Update File: src/c.ts',
  '*** Move to: src/d.ts',
  '*** Delete File: src/old.ts',
  '*** End Patch',
].join('\n');

test('补丁头：Add / Update 都算，移动留落点，删除不算', () => {
  assert.deepEqual(patchFilePaths(PATCH), ['src/a.ts', 'src/b.ts', 'src/d.ts']);
});

test('补丁头：空参数与坏输入不会炸', () => {
  assert.deepEqual(patchFilePaths(''), []);
  assert.deepEqual(patchFilePaths(null), []);
  assert.deepEqual(patchFilePaths({ input: 'x' }), []);
});

test('过程清单摘要：前三份 + 数量', () => {
  const summary = toolStepSummary('apply_patch', JSON.stringify({ input: PATCH }));
  assert.equal(summary, 'src/a.ts、src/b.ts、src/d.ts');
});

test('过程清单摘要：超过三份说个数', () => {
  const many = [
    '*** Begin Patch',
    '*** Add File: a.ts', '+1',
    '*** Add File: b.ts', '+1',
    '*** Add File: c.ts', '+1',
    '*** Add File: d.ts', '+1',
    '*** End Patch',
  ].join('\n');
  assert.equal(toolStepSummary('apply_patch', JSON.stringify({ input: many })), 'a.ts、b.ts、c.ts 等 4 个');
});

test('过程清单摘要：认不出补丁头就退回描述，不编路径', () => {
  assert.equal(toolStepSummary('apply_patch', JSON.stringify({ input: 'not a patch' })), '');
});

test('审批卡：一份写名字，类别键按目录归', () => {
  const one = facts.deriveApprovalFacts({ toolName: 'apply_patch', args: { input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' } }, { cwd: CWD });
  assert.equal(one.fact, '改 a.ts');
  assert.equal(one.highlight, false);
  assert.equal(one.classKey, 'apply_patch:src');
});

test('审批卡：多份写「等 N 个文件」', () => {
  const many = facts.deriveApprovalFacts({ toolName: 'apply_patch', args: { input: PATCH } }, { cwd: CWD });
  assert.equal(many.fact, '改 a.ts 等 3 个文件');
  assert.equal(many.classKey, 'apply_patch:src');
});

test('审批卡：认不出补丁就不出事实行', () => {
  const none = facts.deriveApprovalFacts({ toolName: 'apply_patch', args: { input: 'garbage' } }, { cwd: CWD });
  assert.equal(none.fact, '');
});
