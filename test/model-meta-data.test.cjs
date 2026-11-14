// 资料转换保持独立档位，未知能力不猜成不支持。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('公开推理档位保留 minimal / xhigh / off，不再折叠成四档', async () => {
  const { levelsOf, wiresOf } = await import('../scripts/model-meta-data.mjs');
  assert.deepEqual(wiresOf({ reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] }), { off: 'none' });
  assert.equal(wiresOf({ reasoning: true }), undefined);
  assert.deepEqual(levelsOf({ reasoning_options: [{ type: 'effort', values: ['xhigh', 'minimal', 'none', 'high', 'high', 'max'] }] }), ['off', 'minimal', 'high', 'xhigh', 'max']);
  assert.equal(levelsOf({ reasoning_options: [{ type: 'budget_tokens', min: 1024 }] }), undefined);
  assert.equal(levelsOf({ reasoning: true }), undefined);
  assert.equal(levelsOf({ reasoning_options: [{ type: 'effort', values: ['vendor-budget'] }] }), undefined);
  assert.deepEqual(levelsOf({ reasoning_options: [{ type: 'effort', values: ['off'] }] }), []);
});

test('快照保存真实 GPT-5 档位，读图状态区分未知和明确不支持', () => {
  const meta = require('../lib/mobile/model-meta.js');
  assert.deepEqual(meta.lookupModelMeta('gpt-5').reasoning, ['minimal', 'low', 'medium', 'high']);
  const rows = Object.values(meta.fullModelMeta().items);
  assert.ok(rows.some((row) => row.r?.includes('xhigh')));
  assert.ok(rows.some((row) => row.i === 0));
  assert.ok(rows.some((row) => row.i === undefined));
});
