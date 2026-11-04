'use strict';

/**
 * 「这个 CLI 以后按哪一套跑」（`lib/mobile/cli/config-prefs.js`）。
 *
 * 钉的是用户那句话背后的事：ACP 的配置是会话级的，不提前存一份，每条新对话都回到 CLI
 * 自己的默认 —— 用户就得「每次先改权限再发对话」，权限紧的时候还会被审批卡挡着、这一轮
 * 没结束又改不动。所以这里要保证三件事：
 *
 *   1. 记下来的能原样读回来（含「撤掉这一项」= 回到 CLI 自己的默认）；
 *   2. 选项表能压成一张画得出来的表（分组要摊平、说明要留着 —— 「完全放开」这类话必须写在
 *      选项旁边）；
 *   3. 账只记「用户显式选过的项」，没选过的不写 —— 替用户猜一个档位等于悄悄改了它的行为。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// 先把 DSH_HOME 指到临时目录：`config-prefs.js` 在 require 时才读路径（存的是函数，不是常量），
// 但落盘调用发生在测试体内，先设好就不会污染真实的 `~/.dsh`。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-prefs-'));
process.env.DSH_HOME = sandbox;

const prefs = require('../lib/mobile/cli/config-prefs.js');

test('默认空账：没记过的 CLI 没有任何值，也不假装有一份选项表', () => {
  assert.deepEqual(prefs.prefsOf('nobody'), { values: {}, options: [] });
});

test('值能写能读能撤；撤掉就是「回到 CLI 自己的默认」', () => {
  prefs.setValue('codex', 'mode', 'agent-full-access');
  prefs.setValue('codex', 'reasoning_effort', 'high');
  assert.deepEqual(prefs.prefsOf('codex').values, { mode: 'agent-full-access', reasoning_effort: 'high' });

  // 空值 = 撤掉这一项，不是记一个空字符串（记空串会变成「写一个 CLI 不认识的值」）。
  prefs.setValue('codex', 'mode', '');
  assert.deepEqual(prefs.prefsOf('codex').values, { reasoning_effort: 'high' });

  // 按 CLI 分开记：一家改了不影响另一家。
  prefs.setValue('claude', 'mode', 'plan');
  assert.deepEqual(prefs.prefsOf('claude').values, { mode: 'plan' });
  assert.deepEqual(prefs.prefsOf('codex').values, { reasoning_effort: 'high' });
});

test('选项表：分组摊平、说明留着、没选项的项不出现', () => {
  const described = prefs.describe([
    {
      id: 'mode', name: 'Mode', category: 'mode', currentValue: 'agent',
      options: [
        { value: 'read-only', name: 'Read-only', description: '要审批才能改文件' },
        { value: 'agent-full-access', name: 'Full access', description: '完全放开' },
      ],
    },
    {
      id: 'grouped', name: 'Grouped', category: 'model_config', currentValue: 'a',
      options: [{ group: 'g1', name: 'Go', options: [{ value: 'a', name: 'A' }] }],
    },
    // 一项里一个候选都没有（这一版 CLI 还没准备好）：不画它，别画一张空下拉。
    { id: 'empty', name: 'Empty', options: [] },
    // 形状不对的也照样跳过。
    { name: '没有 id' },
  ])
  assert.deepEqual(described.map((option) => option.id), ['mode', 'grouped'])
  assert.equal(described[0].category, 'mode')
  // 说明是关键信息（「完全放开」意味着它一次都不问），必须留着。
  assert.equal(described[0].choices[1].description, '完全放开')
  // 分组摊平，组名落在 `group` 上，手机那边一行一条。
  assert.deepEqual(described[1].choices, [{ value: 'a', name: 'A', group: 'Go' }])
});

test('选项表能记能读；CLI 后来不给配置项了就把旧表清掉', () => {
  prefs.rememberOptions('gemini', [{ id: 'model', name: 'Model', options: [{ value: 'x', name: 'X' }] }]);
  assert.deepEqual(prefs.prefsOf('gemini').options.map((option) => option.id), ['model']);

  // 记着值的时候清表：值要留着（那是用户的设置），只把过期的表丢掉。
  prefs.setValue('gemini', 'model', 'x');
  prefs.rememberOptions('gemini', []);
  const after = prefs.prefsOf('gemini');
  assert.deepEqual(after.options, []);
  assert.deepEqual(after.values, { model: 'x' });

  // 值和表都没有了：整条记录删掉，文件里不留空壳。
  prefs.setValue('gemini', 'model', '');
  const raw = JSON.parse(fs.readFileSync(prefs.storeFile(), 'utf8'));
  assert.equal(raw.agents.gemini, undefined);
});

test.after(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响 */ }
});

test('新会话开局套用：按新会话自己的选项表校验，写不进去的那一项跳过', () => {
  // 跑的是 service 里那个真函数（`pendingPrefsOf`），不是照抄一份等价实现 —— 否则实现写错了
  // 测试照样绿。三条同时成立才写：记过这一项、新会话里有、这个值还在候选里。
  const { pendingPrefsOf } = require('../lib/mobile/cli/service.js');
  prefs.setValue('attach', 'mode', 'agent-full-access');
  prefs.setValue('attach', 'reasoning_effort', 'high');
  // 记过、但新会话里已经没这一项了（CLI 升级去掉了它）：跳过。
  prefs.setValue('attach', 'gone', 'whatever');
  // 记过、但新会话这一版没有这个值（档位改名成 `full`）：跳过，别硬塞。
  prefs.setValue('attach', 'collaboration_mode', 'legacy');

  const session = {
    agentId: 'attach',
    configOptions: [
      { id: 'mode', category: 'mode', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: 'agent-full-access', name: 'Full' }] },
      { id: 'reasoning_effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      { id: 'collaboration_mode', category: 'collaboration_mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
      // 模型那一项归 `model-prefs` 管：这里必须跳过，否则两边各写一次。
      { id: 'model', category: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
    ],
  }
  assert.deepEqual(pendingPrefsOf(session), [['mode', 'agent-full-access'], ['reasoning_effort', 'high']]);

  // 已经是这个值了：不重复写（每一发都是一次 ACP 往返）。
  session.configOptions = session.configOptions.map((option) => (option.id === 'mode' ? { ...option, currentValue: 'agent-full-access' } : option));
  assert.deepEqual(pendingPrefsOf(session), [['reasoning_effort', 'high']]);

  // 没记过任何东西的 CLI：一项都不写，让 CLI 用它自己的默认。
  assert.deepEqual(pendingPrefsOf({ agentId: 'untouched', configOptions: session.configOptions }), []);
});
