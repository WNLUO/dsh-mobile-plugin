'use strict';

/**
 * 审批卡「事实行」折算的守卫（`lib/mobile/approval-facts.js`）。
 *
 * 纯函数：给定工具名 + 原始参数，锁定「这一行写什么、要不要高亮、按什么动作类别比较同轮重复」。
 * 最要紧的两条红线：
 *  - **解析不出来不出这一行**（`fact: ''`），绝不糊一句会让用户误判的话；
 *  - **高亮只在解析出的程序位命中**：`grep "git push"` 只是提到 push，不当成推送。
 * 用例直接取自设计稿，改动实现时这里一红就是行为变了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const facts = require('../lib/mobile/approval-facts.js');

const CWD = '/repo';
const derive = (calls, extra = {}) => facts.deriveApprovalFacts(calls, { cwd: CWD, ...extra });

test('改一个文件：列出文件名，不高亮', () => {
  const r = derive({ toolName: 'write', args: { file_path: '/repo/app/src/ApprovalPanel.tsx', content: 'x' } });
  assert.equal(r.fact, '改 ApprovalPanel.tsx');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'write:app');
});

test('改多个文件：分句合并', () => {
  const r = derive([
    { toolName: 'write', args: { path: '/repo/app/src/A.tsx', content: 'a' } },
    { toolName: 'edit', args: { path: '/repo/app/src/B.tsx', old_string: 'x', new_string: 'y' } },
  ]);
  assert.equal(r.fact, '改 A.tsx；改 B.tsx');
  assert.equal(r.highlight, false);
});

test('git commit：提交，不高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'git commit -m "补事实行"' } });
  assert.equal(r.fact, '提交：补事实行');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'bash:git:commit');
});

test('git push：推送并高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'git push origin main' } });
  assert.equal(r.fact, '推送 → origin/main');
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:git:push');
});

test('rm：删除并高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'rm -rf build' } });
  assert.equal(r.fact, '删 build');
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:rm');
});

test('装包：装并高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'pnpm add lodash' } });
  assert.equal(r.fact, '装 lodash（pnpm）');
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:pnpm:add');
});

test('curl：连域名，不高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'curl -s https://api.example.com/v1/x' } });
  assert.equal(r.fact, '连 api.example.com');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'bash:curl');
});

test('解析不出的壳：如实说，不高亮', () => {
  const r = derive({ toolName: 'bash', args: { command: 'node -e "$(cat script.js)"' } });
  assert.equal(r.fact, '跑 node（内容无法静态解析）');
  assert.equal(r.highlight, false);
});

test('参数取不到：不出这一行（不是「未知」）', () => {
  const r = derive({ toolName: 'bash', args: null });
  assert.equal(r.fact, '');
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'tool:bash');
});

test('误判反例：命令里只是提到 push，不当成推送', () => {
  const r = derive({ toolName: 'bash', args: { command: 'grep -rn "git push" docs/' } });
  assert.equal(r.highlight, false);
  assert.equal(r.classKey, 'bash:grep');
});

test('长清单截断：保数量、整行不超上限', () => {
  const names = Array.from({ length: 6 }, (_, i) => `averyverylongname${i + 1}`);
  const r = derive({ toolName: 'bash', args: { command: `rm ${names.join(' ')}` } });
  assert.match(r.fact, /等 6 个/);
  assert.ok(r.fact.length <= facts.FACT_MAX, r.fact);
});

/**
 * 包装命令：`env` / `timeout` / `xargs` / `nohup` … 只是外壳，干活的在后面那一条。
 *
 * 剥壳之后类别键落在真正那条命令上，而不是包装器上 —— 同轮重复比较才不会把
 * `timeout 60 rm -rf dist` 和别的 `timeout` 命令当成同一条。
 */
test('包装命令要剥到真正干活的那一条', () => {
  assert.equal(derive({ toolName: 'bash', args: { command: 'timeout 60 rm -rf dist' } }).classKey, 'bash:rm');
  assert.equal(derive({ toolName: 'bash', args: { command: 'env A=1 git commit -m x' } }).classKey, 'bash:git:commit');
});

test('多段命令按段合并，程序名进类别键', () => {
  const r = derive({ toolName: 'bash', args: { command: 'cd app && rm -rf dist' } });
  assert.match(r.fact, /删 dist/);
  assert.equal(r.highlight, true);
  assert.equal(r.classKey, 'bash:cd+rm');
});
