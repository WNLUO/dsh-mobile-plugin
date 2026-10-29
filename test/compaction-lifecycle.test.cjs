'use strict';

/**
 * 上下文压缩行的历史折叠契约（lib/mobile/history-derive.js 的真实实现）。
 *
 * 与 app/scripts/test-compaction-lifecycle.js 同一件事的另一半：直播路径认 `compaction/end`
 * 之后，历史路径必须同口径，否则重新进一次会话，那一百多条「正在压缩…」又回来了
 * （历史是插件从会话日志现折的，折出来的东西直接就是 App 的 messages）。
 *
 * 钉三件事：
 *   1. `compaction/end` 落定那一条（无 error → done、有 error → failed + 原因原文）；
 *   2. 同一轮里的多次尝试只占一行（新尝试原地顶替还没落定的那条，已落地的不顶替）；
 *   3. 成功那条照旧从 compaction/summary 补条数与 token 数。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMessages } = require('../lib/mobile/history-derive.js');

const REFUSED = '422: {"type":"server_error","code":"dsh_compaction_refused","message":"refused"}';

const start = (id, turn, seq) => ({ type: 'compaction/start', seq, time: seq, data: { compactionId: id, turn } });
const end = (id, turn, seq, error) => ({
  type: 'compaction/end', seq, time: seq, data: { compactionId: id, turn, ...(error ? { error } : {}) },
});
const summary = (id, seq) => ({
  type: 'compaction/summary',
  seq,
  time: seq,
  data: { compactionId: id, summary: [{ type: 'text', text: '压缩摘要正文' }], shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1200 },
});
const checkpoint = (id, seq) => ({
  type: 'user/message',
  seq,
  time: seq,
  data: { id: `m-${seq}`, role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: id }, content: [] },
});

const compactions = (items) => items.filter((item) => item.kind === 'compaction');

test('compaction/end 落定这次尝试：无 error → done，有 error → failed 带原因', () => {
  const ok = compactions(deriveMessages([start('c1', 3, 1), end('c1', 3, 2)]));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].state, 'done');
  assert.equal(ok[0].error, null);

  const bad = compactions(deriveMessages([start('c1', 3, 1), end('c1', 3, 2, REFUSED)]));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].state, 'failed');
  assert.equal(bad[0].error, REFUSED);
});

test('同一轮的多次尝试折成一行，跟到最新一次', () => {
  const rows = compactions(deriveMessages([
    start('c1', 3, 1), end('c1', 3, 2, REFUSED),
    start('c2', 3, 3), end('c2', 3, 4, REFUSED),
    start('c3', 3, 5),
  ]));
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].id, 'c3');
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].seq, 1);
});

test('换一轮就另起一条（不同轮不互相顶替）', () => {
  const rows = compactions(deriveMessages([
    start('c1', 3, 1), end('c1', 3, 2, REFUSED),
    start('c2', 4, 5), end('c2', 4, 6, REFUSED),
  ]));
  assert.deepEqual(rows.map((row) => row.id), ['c1', 'c2']);
});

test('一次失败的尝试不会顶掉已经落地（done）的那条', () => {
  const rows = compactions(deriveMessages([
    start('c1', 3, 1), summary('c1', 2), checkpoint('c1', 3), end('c1', 3, 4),
    start('c2', 3, 9), end('c2', 3, 10, REFUSED),
  ]));
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const landed = rows.find((row) => row.id === 'c1');
  assert.equal(landed.state, 'done');
  assert.equal(landed.summary, '压缩摘要正文');
  assert.equal(landed.shadowedItemCount, 3);
  assert.equal(landed.shadowedTokenCount, 1200);
  assert.equal(rows.find((row) => row.id === 'c2').state, 'failed');
});

test('没有 compaction/start 的孤儿 end 也留一条（中途接入的会话）', () => {
  const rows = compactions(deriveMessages([end('c9', 3, 1, REFUSED)]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].error, REFUSED);
});

/**
 * 压缩行必须跟直播侧同形：带一个空正文。
 *
 * 反例是 2026-10-27 的真机白屏：历史派生的压缩行没有这个字段，没跟上判空修复的旧安装包
 * 在气泡里直接读正文，`Cannot read property 'trim' of undefined`，整页崩掉。四种造法
 * （start / end / summary / 检查点）都要覆盖，漏掉哪一种，老客户端就在那一种上崩。
 */
test('派生的压缩行带空正文（旧安装包读正文不做判空）', () => {
  const rows = compactions(deriveMessages([
    start('c1', 3, 1),
    end('c1', 3, 2, REFUSED),
    checkpoint('c2', 4),
    summary('c3', 5),
    end('c9', 6, 6),
  ]));
  assert.equal(rows.length, 4, JSON.stringify(rows.map((row) => row.id)));
  for (const row of rows) assert.equal(row.text, '', `${row.id} 缺 text`);
  // 其它结构行不受影响：turn-aborted 照旧不带正文（`history-turn-end` 钉的就是这一条）。
  const aborted = deriveMessages([{ type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'aborted' } } }]);
  assert.equal(aborted[0].text, undefined);
});

/**
 * 手动 `/compact` 在桌面上是**一件事**：`CompactionCommandCard` 只画一个 `CompactionItem`
 * （标题取命令名、摘要位放条数与 token 数），命令行那块根本不出现。
 *
 * 手机侧以前两半都发：重连拿到半截增量窗口时，屏幕上并排三行 ——「compact·执行中…」、
 * 「上下文已压缩·压缩摘要不可用」、「命令·Compacted 206 history items」（宿主 en locale 的
 * 英文原句，标题连命令名都丢了）。现在压缩行按 `sourceCommandId` 认领命令行。
 */
const withCommand = (event, sourceCommandId) => ({ ...event, data: { ...event.data, sourceCommandId } });
const runCommand = (commandId, seq) => ({ type: 'command/run', seq, time: seq, data: { commandId, name: 'compact' } });
const doneCommand = (commandId, seq) => ({
  type: 'command/done',
  seq,
  time: seq,
  data: { commandId, kind: 'success', text: 'Compacted 206 history items (~79534 tokens).' },
});

test('手动 /compact：命令行被压缩行认领，只留一行、标题继承命令名', () => {
  const items = deriveMessages([
    runCommand('cmd-1', 1),
    withCommand(start('c1', null, 2), 'cmd-1'),
    withCommand(summary('c1', 3), 'cmd-1'),
    withCommand(end('c1', null, 4), 'cmd-1'),
    doneCommand('cmd-1', 5),
  ]);
  assert.equal(items.filter((item) => item.kind === 'command').length, 0, '命令行不该单独成行');
  const rows = compactions(items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].compactionCommandId, 'cmd-1');
  assert.equal(rows[0].compactionTitle, 'compact');
  assert.equal(rows[0].state, 'done');
  assert.equal(rows[0].shadowedItemCount, 3);
  assert.ok(rows[0].summary, '摘要仍要带上（展开区靠它）');
});

test('增量窗口只覆盖半截生命周期时，也不漏出无名命令行', () => {
  const items = deriveMessages([
    withCommand(end('c1', null, 4), 'cmd-1'),
    doneCommand('cmd-1', 5),
  ]);
  assert.equal(items.filter((item) => item.kind === 'command').length, 0, '认领后命令行不上屏');
  assert.equal(compactions(items).length, 1);
});

test('没有压缩行配对的命令照旧单独成行（别把普通命令吞掉）', () => {
  const items = deriveMessages([runCommand('cmd-2', 1), doneCommand('cmd-2', 2)]);
  const commands = items.filter((item) => item.kind === 'command');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'compact');
});

test('done 先到时建的命令行也带 id（否则 App 按 id 合并配不上那半截 run 行）', () => {
  const items = deriveMessages([doneCommand('cmd-3', 2)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'command');
  assert.equal(items[0].id, 'cmd-3');
});

/**
 * 触发命令的 id 还有第二个落点：**压缩检查点自己的 `source.sourceCommandId`**。
 *
 * 桌面 `compactSource` 读的就是它（`compaction/*` 的 data 只是另一半证据）。只认
 * `compaction/*` 时，检查点先到、那些事件在增量窗口外的场合就配不上：屏幕上并排两行
 * （一条压缩行、一条「命令 · Compacted N history items」），压缩行还退化成「压缩摘要不可用」。
 */
const checkpointWithCommand = (id, seq, commandId) => ({
  type: 'user/message',
  seq,
  time: seq,
  data: {
    id: `m-${seq}`,
    role: 'user',
    source: { kind: 'plugin', plugin: 'compact', compactionId: id, sourceCommandId: commandId },
    content: [],
  },
});

test('检查点自带 sourceCommandId 也能认领命令行，条数不齐时用命令结果兜摘要位', () => {
  const items = deriveMessages([
    runCommand('cmd-5', 1),
    checkpointWithCommand('c5', 2, 'cmd-5'),
    doneCommand('cmd-5', 3),
  ]);
  assert.equal(items.filter((item) => item.kind === 'command').length, 0, '命令行不该单独成行');
  const rows = compactions(items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].compactionTitle, 'compact');
  assert.equal(rows[0].shadowedItemCount, null);
  assert.equal(rows[0].compactionFallbackSummary, 'Compacted 206 history items (~79534 tokens).');
});

test('命令那半截完全不在窗口里时标题仍写 compact', () => {
  const rows = compactions(deriveMessages([checkpointWithCommand('c6', 2, 'cmd-6')]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].compactionTitle, 'compact');
  assert.equal(rows[0].compactionFallbackSummary, undefined);
});

test('条数齐全时不塞命令原文兜底（桌面 counts 优先于 fallbackSummary）', () => {
  const rows = compactions(deriveMessages([
    checkpointWithCommand('c7', 2, 'cmd-7'),
    summary('c7', 3),
    doneCommand('cmd-7', 4),
  ]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shadowedItemCount, 3);
  assert.equal(rows[0].compactionFallbackSummary, undefined);
});
