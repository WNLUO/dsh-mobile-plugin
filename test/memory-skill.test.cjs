'use strict';

/**
 * 记忆层（memory.js）、自建技能库（skill-store.js）、技能导入（skill-import.js）的单元测试。
 *
 * 每条断言对着一个真会出错的写法：
 *
 *  1. 敏感信息（密码 / 验证码 / 卡号 / 身份证 / api key）不许落盘；手机号、地址这类常用事实放行。
 *  2. 记忆按类型去重、跨 scope 分开、做法默认待批准、删除与改动可撤销。
 *  3. 技能草稿五节齐全才收；落盘后正文与 references / scripts 读得回、路径穿越读不到。
 *  4. 外来技能强制 untrusted、frontmatter 必填、路径穿越与超限拒收、可运行脚本单独标。
 *
 * 只跑临时目录，绝不碰真实 ~/.dsh。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../lib/mobile/memory.js');
const skillImport = require('../lib/mobile/skill-import.js');
const skillStore = require('../lib/mobile/skill-store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-skill-'));
}

/** 一份五节齐全的合法技能。 */
function sampleSkill(name = 'demo-skill') {
  return `---
name: ${name}
description: 演示技能，用户要演示这类事时用。
---

# 演示

## 入口

从用户指定的 App 开始。

## 步骤

1. 第一步。
2. 第二步。

## 容易出错的地方

- 界面改版会让入口对不上。

## 怎样算办成

- 用户看到预期结果。

## 什么时候停下交给用户

- 付款前停下。
`;
}

// ── 敏感信息关卡 ────────────────────────────────────────────────────────────

test('sensitiveHit：秘密拦下、常用事实放行', () => {
  assert.equal(memory.sensitiveHit('支付密码是 hunter2secret'), 'password');
  assert.equal(memory.sensitiveHit('验证码 1 2 3 4'), 'password');
  assert.equal(memory.sensitiveHit('card 4111 1111 1111 1111'), 'card_number');
  assert.equal(memory.sensitiveHit('身份证 11010519491231002X'), 'id_number');
  assert.equal(memory.sensitiveHit('key sk-abc12345def67890ghi'), 'api_key');
  // 常用事实放行：手机号、地址、生日。
  assert.equal(memory.sensitiveHit('我电话 13800138000'), null);
  assert.equal(memory.sensitiveHit('家住北京市朝阳区'), null);
  assert.equal(memory.sensitiveHit('生日 1990 年'), null);
});

// ── 记忆账本 ────────────────────────────────────────────────────────────────

function freshMemory(extra = {}) {
  let n = 0;
  let t = 1000;
  return memory.createMemoryStore({
    rootDir: tmpDir(),
    clock: () => (t += 1),
    ids: () => `id-${(n += 1)}`,
    ...extra,
  });
}

test('memory：按类型去重、做法待批准、删除与撤销', () => {
  const store = freshMemory();
  const a = store.add({ kind: 'fact', content: '我不吃香菜', keywords: ['香菜'], source: { type: 'user_said', quote: '我不吃香菜' } });
  assert.equal(a.deduped, false);
  assert.equal(a.item.status, 'active');

  const dup = store.add({ kind: 'fact', content: '我不吃香菜' });
  assert.equal(dup.deduped, true);
  assert.equal(dup.item.id, a.item.id);
  assert.equal(store.list().length, 1);

  const proc = store.add({ kind: 'procedure', content: '点咖啡先选门店再选规格' });
  assert.equal(proc.item.status, 'pending');
  assert.equal(store.approve({ id: proc.item.id }), true);
  assert.equal(store.list().find((it) => it.id === proc.item.id).status, 'active');

  const pref = store.add({ kind: 'preference', content: '回复尽量短' });
  assert.equal(store.forget({ id: pref.item.id }).undoToken !== null, true);
  assert.equal(store.list().some((it) => it.id === pref.item.id), false);
  assert.equal(store.undo('no-such-token'), false); // 不存在的令牌
});

test('memory：删除与改动都能撤销', () => {
  const store = freshMemory();
  const item = store.add({ kind: 'preference', content: '叫我老王' });
  const forgotten = store.forget({ id: item.item.id });
  assert.equal(store.list().length, 0);
  assert.equal(store.undo(forgotten.undoToken), true);
  assert.equal(store.list().length, 1);

  const updated = store.update({ id: item.item.id, content: '叫我老师' });
  assert.equal(store.list()[0].content, '叫我老师');
  assert.equal(store.undo(updated.undoToken), true);
  assert.equal(store.list()[0].content, '叫我老王');
});

test('memory：跨 workspace 分开、clear、limit、sensitive', () => {
  const store = freshMemory({ limit: 2 });
  const scopeA = memory.scopeForWorkspace('/a/project');
  const scopeB = memory.scopeForWorkspace('/b/project');
  assert.notEqual(scopeA, scopeB);
  assert.equal(store.fileFor(scopeA) === store.fileFor(scopeB), false);

  store.add({ scope: scopeA, kind: 'fact', content: 'A 项目用 vim' });
  store.add({ scope: scopeB, kind: 'fact', content: 'B 项目用 emacs' });
  assert.deepEqual(store.list(scopeA).map((it) => it.content), ['A 项目用 vim']);
  assert.deepEqual(store.list(scopeB).map((it) => it.content), ['B 项目用 emacs']);

  store.add({ scope: scopeA, kind: 'fact', content: 'A 项目周五发版' });
  assert.throws(() => store.add({ scope: scopeA, kind: 'fact', content: '第三条' }), (e) => e.code === 'memory_full');

  assert.throws(() => store.add({ kind: 'fact', content: '密码是 hunter2secret' }), (e) => e.code === 'sensitive');

  store.clear(scopeA);
  assert.equal(store.list(scopeA).length, 0);
});

test('memory：检索命中关键词并渲染上下文', () => {
  const store = freshMemory();
  store.add({ kind: 'preference', content: '我不吃香菜', keywords: ['香菜'] });
  store.add({ kind: 'fact', content: '我住北京' });
  const hits = store.search(memory.GLOBAL_SCOPE, '香菜', { limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.content, '我不吃香菜');

  const ctx = memory.renderContext(store.list());
  assert.match(ctx, /Memories about the user/);
  assert.match(ctx, /不吃香菜/);
});

// ── 技能导入 ────────────────────────────────────────────────────────────────

test('skill-import：合法外来技能通过并标 untrusted', () => {
  const res = skillImport.validateImport({ markdown: sampleSkill() });
  assert.equal(res.ok, true);
  assert.equal(res.untrusted, true);
  assert.equal(res.name, 'demo-skill');
});

test('skill-import：frontmatter 必填、名字 kebab、路径穿越与超限拒收', () => {
  assert.equal(skillImport.validateImport({ markdown: '# 没有头\n\n## 入口\n' }).problem, 'missing_frontmatter');
  assert.equal(skillImport.validateImport({ markdown: sampleSkill('Bad Name') }).problem, 'invalid_name');
  const bad = skillImport.validateImport({ markdown: sampleSkill(), files: [{ path: '../evil.md', content: 'x' }] });
  assert.equal(bad.problem, 'bad_path');
  const tooMany = skillImport.validateImport({
    markdown: sampleSkill(),
    files: Array.from({ length: 101 }, (_, i) => ({ path: `references/f${i}.md`, content: 'x' })),
  });
  assert.equal(tooMany.problem, 'too_many_files');
  // 内置技能名不能导入。
  const builtin = skillImport.validateImport({ markdown: sampleSkill('intent-router') }, { builtinNames: new Set(['intent-router']) });
  assert.equal(builtin.problem, 'builtin_name');
});

test('skill-import：可运行脚本单独标定、附件全标 untrusted', () => {
  const res = skillImport.validateImport({
    markdown: sampleSkill(),
    files: [
      { path: 'scripts/run.py', content: 'print(1)\n' },
      { path: 'scripts/manifest.json', content: JSON.stringify([{ file: 'scripts/run.py', runnable: true, needs: ['python3'] }]) },
      { path: 'references/notes.md', content: 'hi' },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.scriptRunnable, ['scripts/run.py']);
  assert.equal(res.files.every((f) => f.untrusted === true), true);
  assert.equal(res.files.find((f) => f.path === 'scripts/run.py').runnable, true);
  assert.equal(res.files.find((f) => f.path === 'references/notes.md').runnable, false);
});

test('skill-import：分享剥掉本机字段，导入产出待收下草稿', () => {
  const shared = skillImport.shareable(`---
name: demo-skill
description: x
source: imported
learned_from: run-42
updates: other-skill
---

## 入口

a
`);
  assert.doesNotMatch(shared, /source:/);
  assert.doesNotMatch(shared, /learned_from:/);
  assert.doesNotMatch(shared, /updates:/);

  const ready = skillImport.importSkill({ markdown: sampleSkill() }, { id: 'd1', now: 5 });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.draft.untrusted, true);
  assert.equal(ready.draft.source, 'imported');

  const dup = skillImport.importSkill({ markdown: sampleSkill() }, { pendingNames: new Set(['demo-skill']) });
  assert.equal(dup.status, 'rejected');
  assert.equal(dup.problem, 'draft_pending');

  const update = skillImport.importSkill({ markdown: sampleSkill() }, { personalNames: new Set(['demo-skill']) });
  assert.equal(update.draft.isUpdateOf, 'demo-skill');
});

// ── 技能库 ──────────────────────────────────────────────────────────────────

function freshSkills() {
  let n = 0;
  let t = 1000;
  const root = tmpDir();
  const draftsFile = path.join(tmpDir(), 'drafts.json');
  return skillStore.createSkillStore({
    rootDir: root,
    draftsFile,
    clock: () => (t += 1),
    ids: () => `draft-${(n += 1)}`,
  });
}

test('skill-store：草稿五节齐全才收、脱敏后落盘、正文与附件读得回', () => {
  const store = freshSkills();
  const md = store.composeMarkdown({
    name: 'order-coffee',
    description: '用户要点咖啡时用。',
    sections: {
      入口: '从用户指定的咖啡 App 开始。',
      步骤: '1. 给「王小明」下单 500 元的拿铁。',
      容易出错的地方: '同名店价格不同。',
      怎样算办成: '看到订单已提交。',
      什么时候停下交给用户: '付款前停。',
    },
  });
  const prepared = store.prepareDraft({
    markdown: md,
    literals: ['王小明', '500'],
    files: [{ path: 'references/notes.md', content: 'hello' }],
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.draft.name, 'order-coffee');

  const full = store.getDraft(prepared.draft.id);
  assert.doesNotMatch(full.markdown, /王小明/);
  assert.doesNotMatch(full.markdown, /500/);

  const approved = store.approveDraft(prepared.draft.id);
  assert.equal(approved.ok, true);
  assert.equal(approved.name, 'order-coffee');

  const content = store.getSkillContent('order-coffee');
  assert.equal(content.ok, true);
  assert.match(content.content, /## 入口/);

  const listed = store.listResources('order-coffee');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.resources.map((r) => r.path), ['references/notes.md']);

  const read = store.readResource('order-coffee', 'references/notes.md');
  assert.equal(read.ok, true);
  assert.equal(read.text, 'hello');

  // 路径穿越读不到。
  assert.equal(store.readResource('order-coffee', 'references/../../etc/passwd').problem, 'bad_path');
  assert.equal(store.readResource('order-coffee', 'SKILL.md').problem, 'bad_path');
});

test('skill-store：缺节/敏感拒收、同名不覆盖、更新草稿可覆盖', () => {
  const store = freshSkills();
  assert.equal(store.prepareDraft({ name: 'x', description: 'y', sections: { 入口: 'a' } }).problem, 'missing_section');

  const sensitive = sampleSkill('sensitive-skill').replace('## 步骤\n\n1. 第一步。', '## 步骤\n\n1. 密码是 hunter2secret。');
  assert.equal(store.prepareDraft({ markdown: sensitive }).problem, 'sensitive');

  const d1 = store.prepareDraft({ markdown: sampleSkill('take-me') });
  assert.equal(store.approveDraft(d1.draft.id).ok, true);
  const d2 = store.prepareDraft({ markdown: sampleSkill('take-me') });
  assert.equal(store.approveDraft(d2.draft.id).problem, 'name_taken');

  const d3 = store.prepareDraft({ markdown: sampleSkill('take-me'), isUpdateOf: 'take-me' });
  const updated = store.approveDraft(d3.draft.id);
  assert.equal(updated.ok, true);
});
