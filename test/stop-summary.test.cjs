'use strict';

// 停止交代：用户按停止后那份「本轮交代」的折叠口径（`lib/mobile/stop-summary.js`）。
//
// 这里钉的是「从步骤流只读出那一步本身写着的东⻄」：成功的一步进「做了什么 / 看到了什么」，
// 没跑成的一步进「没做完」，思考步只当最后一句。状态只认步骤自己的 `state`，读不到就当还在跑
// （于是它落进「没做完」）；「对外发出几次」只认步骤上显式的标记，不按工具名或文案猜。
//
// 位置口径与 `live-steps.js` / `history-derive.js` 一致：输入是 `{ key, step }` 数组。

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize, toStepList, stateOf, outwardOf, commandLooksReadOnly, stripCdPrefix } = require('../lib/mobile/stop-summary.js');

const entry = (step) => ({ key: step.callId ? `tool:${step.callId}` : 'think:0', step });
const ok = (name, summary, extra) => entry({ kind: 'tool', name, summary, state: 'ok', ...(extra || {}) });
const failed = (name, summary, state) => entry({ kind: 'tool', name, summary, state });

test('成功的一步按「读类 / 非读类」分成看到了什么与做了什么', () => {
  const view = summarize([
    ok('read', '/tmp/a.md'),
    ok('edit', '/tmp/a.md'),
    ok('web_search', 'DSH 移动端'),
  ]);
  assert.deepEqual(view.saw, ['/tmp/a.md', 'DSH 移动端']);
  assert.deepEqual(view.did, ['/tmp/a.md']);
});

test('没跑成的一步进「没做完」，状态三种都算', () => {
  const view = summarize([
    failed('bash', 'npm test', 'error'),
    failed('bash', 'pnpm build', 'stopped'),
    failed('bash', 'curl x', 'running'),
  ]);
  assert.deepEqual(view.unfinished, ['npm test', 'pnpm build', 'curl x']);
  assert.deepEqual(view.did, []);
});

test('读不到 state 就当还在跑（落进没做完，不写成做成了）', () => {
  const view = summarize([entry({ kind: 'tool', name: 'edit', summary: '/tmp/a.md' })]);
  assert.deepEqual(view.did, []);
  assert.deepEqual(view.unfinished, ['/tmp/a.md']);
});

test('思考步不进做了什么，只当最后一句交代', () => {
  const view = summarize([
    entry({ kind: 'think', summary: '先看看这里', state: 'ok' }),
    ok('read', '/tmp/a.md'),
    entry({ kind: 'think', summary: '接下来要改配置', state: 'ok' }),
  ]);
  assert.deepEqual(view.did, []);
  assert.equal(view.closing, '接下来要改配置');
});

test('「对外发出几次」只认显式标记，不按工具名猜', () => {
  const quiet = summarize([ok('bash', 'git push'), ok('mail_send', '发给甲方')]);
  assert.equal(quiet.outboundCount, undefined, '没标记就不写这一句');
  const marked = summarize([
    ok('mail_send', '发给甲方', { outward: true }),
    ok('bash', '下单', { irreversible: true }),
  ]);
  assert.equal(marked.outboundCount, 2);
});

test('全空的一轮给空交代（App 那边据此不出卡）', () => {
  const view = summarize([]);
  assert.deepEqual(view.did, []);
  assert.deepEqual(view.saw, []);
  assert.equal(view.outboundCount, undefined);
  assert.equal(view.unfinished, undefined);
  assert.equal(view.closing, undefined);
});

test('两种输入形状都认：裸步骤数组与 { steps }', () => {
  const steps = [ok('read', '/tmp/a.md')];
  assert.deepEqual(summarize(steps), summarize({ steps }));
  assert.equal(toStepList({ steps }).length, 1);
});

test('状态与对外标记的判据本身也要对', () => {
  assert.equal(stateOf({ state: 'ok' }), 'ok');
  assert.equal(stateOf({ state: 'weird' }), 'running');
  assert.equal(stateOf({}), 'running');
  assert.equal(outwardOf({ outward: true }), true);
  assert.equal(outwardOf({ irreversible: true }), true);
  assert.equal(outwardOf({ outward: 'send' }), true);
  assert.equal(outwardOf({}), false);
});

// ── 读还是写：`bash` 到底动没动手 ──────────────────────────────────────────────
//
// 手机上一轮活里绝大多数步骤是 `bash`。全按「做了什么」写，交代就变成十几行一样的命令、
// 其实一件东西都没改；这里钉的是「只读命令归到看到了什么、认不出就退回做了什么」。

test('只读命令归「看到了什么」，写命令仍归「做了什么」', () => {
  const view = summarize([
    ok('bash', 'grep -n "ota" docs/release-notes.md'),
    ok('bash', 'cat app/src/version.ts'),
    ok('bash', 'sed -n "1,120p" app/src/services/x.ts'),
    ok('bash', 'git log --oneline -S"APP_BUILD"'),
    ok('bash', 'ls app/src/services/updates/'),
    ok('bash', 'npm run map'),
    ok('bash', 'node -e "fs.writeFileSync(1)"'),
    ok('edit', '/tmp/a.md'),
  ]);
  assert.deepEqual(view.saw, [
    'grep -n "ota" docs/release-notes.md',
    'cat app/src/version.ts',
    'sed -n "1,120p" app/src/services/x.ts',
    'git log --oneline -S"APP_BUILD"',
    'ls app/src/services/updates/',
  ]);
  assert.deepEqual(view.did, ['npm run map', 'node -e "fs.writeFileSync(1)"', '/tmp/a.md']);
});

test('判错的方向不对称：认不出的命令退回「做了什么」', () => {
  const read = (command) => commandLooksReadOnly(command);
  assert.equal(read('grep -n x a.md | head -5'), true, '管道不算写（正则里的 \\| 也不能被误切）');
  assert.equal(read('grep -rn "a\\|b" src'), true);
  assert.equal(read('sed -n 1,10p a.ts'), true, 'sed -n 是读');
  assert.equal(read('sed -i s/a/b/ a.ts'), false, 'sed -i 是改文件');
  assert.equal(read('git log --oneline'), true);
  assert.equal(read('git status'), true);
  assert.equal(read('git commit -m x'), false);
  assert.equal(read('git push'), false);
  assert.equal(read('cat a > b'), false, '重定向就是写');
  assert.equal(read('npm run build'), false);
  assert.equal(read('rm -rf dist'), false);
  assert.equal(read('some_unknown_cli --flag'), false, '不认得的一律当写');
});

test('提交流里的 bash 摘要会剥掉每次都一样的 cd 前缀', () => {
  const view = summarize([
    ok('bash', 'cd "/Volumes/移动硬盘/code/项目/DSH-mobile" && grep -n -i "ota" docs/dev-map…'),
    ok('bash', 'cd "/Volumes/移动硬盘/code/项目/DSH-mobile" && ls app/src/services/updates/'),
  ]);
  assert.deepEqual(view.saw, ['grep -n -i "ota" docs/dev-map…', 'ls app/src/services/updates/']);
  assert.equal(stripCdPrefix('cd /x && ls a && cd /y && cat b'), 'ls a && cat b');
  assert.equal(stripCdPrefix('ls a'), 'ls a', '没有前缀就原样返回');
});

test('重复的标签只留一条（同一份清单不把篇幅撑长）', () => {
  const view = summarize([
    ok('read', '/tmp/a.md'),
    ok('read', '/tmp/a.md'),
    ok('bash', 'grep -n x docs/a.md'),
    ok('bash', 'grep -n x docs/a.md'),
  ]);
  assert.deepEqual(view.saw, ['/tmp/a.md', 'grep -n x docs/a.md']);
  const broken = summarize([
    failed('bash', 'npm test', 'error'),
    failed('bash', 'npm test', 'error'),
  ]);
  assert.deepEqual(broken.unfinished, ['npm test']);
});

// ── 按轮次答（重新打开一条老会话时 App 补的那一发）────────────────────────────
//
// 判据不是「消息上带的 turn 号」—— 历史派生的普通消息根本不带它；锚点是这一轮收口的
// `turn-aborted` 行（id 就是 `turn-<轮号>`、带这一轮的收口 seq），再挑 `turnProcess.startSeq`
// 最大且更早的那份清单：那就是开启这一轮的消息。

const { handleStopSummary, lastTurnSteps, turnSteps } = require('../lib/mobile/session-stop-summary.js');
const { deriveMessages } = require('../lib/mobile/history-derive.js');

const ev = (type, data, seq) => ({ type, seq, time: 1000 + seq, data });
const user = (id, text, seq) => ev('user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq);
const assistant = (turn, step, seq, content) => ev('assistant/message', { turn, step, message: { id: `a${seq}`, role: 'assistant', content } }, seq);
const result = (turn, step, seq, callId, text, extra) => ev('tool/result', {
  turn, step, message: { source: { callId }, content: [{ type: 'text', text }] }, ...(extra || {}),
}, seq);
const end = (turn, seq, reason) => ev('turn/end', { turn, reason }, seq);

/** 两轮都被停掉：重新打开会话、末尾是中止轮时，按轮取要能把前一轮也取对。 */
function rawTwoTurns() {
  return [
    user('u1', '第一轮', 1),
    assistant(1, 1, 2, [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/tmp/old.md"}' }]),
    result(1, 1, 3, 'c1', '旧文件正文'),
    end(1, 4, { kind: 'aborted' }),
    user('u5', '第二轮', 5),
    assistant(2, 1, 6, [{ type: 'tool-call', id: 'c2', name: 'edit', arguments: '{"file_path":"/tmp/new.md"}' }]),
    result(2, 1, 7, 'c2', 'ok'),
    end(2, 8, { kind: 'aborted' }),
  ];
}

const twoTurns = () => deriveMessages(rawTwoTurns(), 's1');

test('按轮取：点名哪一轮就折哪一轮的清单，不是「最后一个」', () => {
  const messages = twoTurns();
  assert.deepEqual(turnSteps(messages, 1).map((step) => step.summary), ['/tmp/old.md']);
  assert.deepEqual(turnSteps(messages, 2).map((step) => step.summary), ['/tmp/new.md']);
  // 不带轮号的老行为不变：最近一轮。
  assert.deepEqual(lastTurnSteps(messages).map((step) => step.summary), ['/tmp/new.md']);
});

test('按轮取：窗口里没有那一轮的收口行就回空（App 不出卡，不报错）', () => {
  assert.deepEqual(turnSteps(twoTurns(), 9), []);
  // 收口行在、但它前面没有任何清单（那一轮真没跑过程）：也是空。
  const bare = deriveMessages([user('u1', '只说了一句', 1), end(1, 2, { kind: 'aborted' })], 's1');
  assert.deepEqual(turnSteps(bare, 1), []);
});

test('按轮取：取的是收口之前离它最近的那份清单，后面那一轮的不算', () => {
  // 第 2 轮的清单 seq 更大，取第 1 轮时不能被它顶掉（按「最大且更早」挑）。
  const messages = twoTurns();
  assert.deepEqual(turnSteps(messages, 1).map((step) => step.summary), ['/tmp/old.md']);
  // 行在窗口里但只截到一半（清单在窗口外）：回空，不拿别人的凑。
  assert.deepEqual(turnSteps(messages.filter((item) => item.role === 'assistant' || item.kind), 1), []);
});

/** 只认 history 的假宿主。 */
function fakeCtx(events) {
  const calls = [];
  return {
    calls,
    apiProxy: {
      sessions: {
        history: async (request) => {
          calls.push(request.payload);
          const page = events.slice(-(request.payload.maxMessages || 50)).map((event) => ({ type: 'event', event }));
          return { result: { ok: true, value: { events: page, hasMore: false } } };
        },
      },
    },
  };
}

function call(ctx, query) {
  return new Promise((resolve) => {
    const res = {
      req: { headers: {} },
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    handleStopSummary(ctx, { url: `/api/mobile/v1/session/stop-summary?${new URLSearchParams(query)}` }, res);
  });
}

test('出口带 turn：回的就是那一轮的交代', async () => {
  const first = await call(fakeCtx(rawTwoTurns()), { sessionId: 's1', turn: '1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.source, 'history');
  assert.deepEqual(first.body.summary.saw, ['/tmp/old.md']);
  assert.deepEqual(first.body.summary.did, []);
  const second = await call(fakeCtx(rawTwoTurns()), { sessionId: 's1', turn: '2' });
  assert.deepEqual(second.body.summary.did, ['/tmp/new.md']);
});

test('出口不带 turn：仍是最近一轮（向后兼容，刚按停止那一刻走这条）', async () => {
  const latest = await call(fakeCtx(rawTwoTurns()), { sessionId: 's1' });
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.body.summary.did, ['/tmp/new.md']);
});

test('出口点名一轮不存在的轮：空交代、200，不是报错', async () => {
  const missing = await call(fakeCtx(rawTwoTurns()), { sessionId: 's1', turn: '9' });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, true);
  assert.deepEqual(missing.body.summary, { did: [], saw: [] });
});

test('出口：turn 参数不合法就按「最近一轮」处理，不乱猜轮号', async () => {
  const bad = await call(fakeCtx(rawTwoTurns()), { sessionId: 's1', turn: 'abc' });
  assert.equal(bad.status, 200);
  assert.deepEqual(bad.body.summary.did, ['/tmp/new.md']);
});
