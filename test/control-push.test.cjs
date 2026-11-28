'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPushNotifier } = require('../lib/mobile/push-notify.js');

// Run the production wiring without starting the host or loading persisted state.
const source = fs.readFileSync(path.join(__dirname, '../lib/impl.js'), 'utf8');
const wiring = source.match(/^  pushNotify = createPushNotifier\(\{[\s\S]*?^  \}\)/m)[0];
const assemble = new Function('state', 'CONTROL_BASE_URL', 'createPushNotifier', 'ctx', 'require',
  `let pushNotify;\n${wiring};\nreturn pushNotify;`);
const BASE = 'https://control.test/findme';
const TOKEN = 'synthetic-stored-token';
const approval = { type: 'approval/requested', rpcId: 'rpc-approval', approvalId: 'a-1', reason: 'Approve task' };
const question = { type: 'question/requested', rpcId: 'rpc-question',
  questions: [{ id: 'q1', question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }] }] };
const notifications = [
  ['approval', n => n.notifyInteraction('session-1', approval)],
  ['question', n => n.notifyInteraction('session-1', question)],
  ['completed', n => n.notifyTurnEnded('session-1', { turn: 1, status: 'completed' }, 'Task')],
  ['failed', n => n.notifyTurnEnded('session-1', { turn: 2, status: 'failed' }, 'Task')],
];
const drain = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, patch = {}, workspaceIdOf = async () => 'workspace-1') {
  const state = { controlToken: TOKEN, instanceId: 'instance-1', ...patch };
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url, ...init, payload: JSON.parse(init.body) });
    return { ok: true };
  });
  t.mock.method(console, 'warn', () => {});
  const notifier = assemble(state, BASE, createPushNotifier, {}, id => {
    assert.equal(id, './mobile/workspace-id.js');
    return { workspaceIdOf };
  });
  return { state, posts, notifier };
}

for (const [kind, notify] of notifications) {
  test(`control reporting disabled blocks ${kind} push with a stored token`, async t => {
    const { state, posts, notifier } = fixture(t, { controlReportEnabled: false });
    await notify(notifier);
    await drain();
    assert.equal(posts.length, 0);
    assert.equal(state.controlToken, TOKEN, 'disabling reporting preserves the stored token');
    state.controlReportEnabled = true;
    await notify(notifier);
    await drain();
    assert.equal(posts.length, 1, 'a blocked notification must not consume its deduplication slot');
  });
}

for (const flag of [true, undefined]) {
  test(`control reporting ${flag} preserves all four authenticated pushes`, async t => {
    const { posts, notifier } = fixture(t, flag === undefined ? {} : { controlReportEnabled: flag });
    for (const [, notify] of notifications) await notify(notifier);
    await drain();
    assert.equal(posts.length, 4);
    assert.deepEqual(posts.map(p => p.payload.interaction?.kind || p.payload.kind),
      ['approval', 'question', 'completed', 'failed']);
    for (const post of posts) {
      assert.equal(post.url, `${BASE}/push/send`);
      assert.equal(post.method, 'POST');
      assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(post.headers['x-dsh-instance'], 'instance-1');
      assert.equal(post.payload.workspaceId, 'workspace-1');
      assert.equal(post.payload.sessionId, 'session-1');
    }
    assert.equal(posts[0].payload.interaction.approvalId, 'a-1');
    assert.equal(posts[1].payload.interaction.questions[0].question, 'Choose one');
    assert.deepEqual(posts.slice(2).map(p => p.payload.body), ['✓', '✗']);
  });
}

for (const field of ['controlToken', 'instanceId']) {
  test(`enabled reporting still requires ${field} to push`, async t => {
    const { posts, notifier } = fixture(t, { controlReportEnabled: true, [field]: '' });
    for (const [, notify] of notifications) await notify(notifier);
    await drain();
    assert.equal(posts.length, 0);
  });
}

for (const [kind, notify] of notifications) {
  test(`disabling reporting during workspace resolution blocks ${kind} push`, async t => {
    let release;
    const workspace = new Promise(resolve => { release = resolve; });
    const { state, posts, notifier } = fixture(t, { controlReportEnabled: true }, () => workspace);
    const pending = notify(notifier);
    assert.equal(posts.length, 0, 'workspace resolution is genuine pre-send async work');
    state.controlReportEnabled = false;
    release('workspace-1');
    await pending;
    await drain();
    assert.equal(posts.length, 0);
    assert.equal(state.controlToken, TOKEN);
  });
}

test('disabling reporting blocks a queued approval upgrade without recalling an already sent request', async t => {
  const { state, posts, notifier } = fixture(t, { controlReportEnabled: true });
  await notifier.notifyInteraction('session-1', { ...approval, approvalId: 'm-placeholder' });
  let finishRequest;
  const response = new Promise(resolve => { finishRequest = resolve; });
  t.mock.method(globalThis, 'fetch', (url, init) => {
    posts.push({ url, ...init, payload: JSON.parse(init.body) });
    return response;
  });
  const sending = notifier.notifyInteraction('session-1', approval);
  await drain();
  const queued = notifier.notifyInteraction('session-1', approval);
  await drain();
  assert.equal(posts.length, 2, 'the second upgrade waits for the first request');
  const signal = posts[1].signal;
  state.controlReportEnabled = false;
  finishRequest({ ok: true });
  await Promise.all([sending, queued]);
  assert.equal(posts.length, 2, 'the queued upgrade must not send after reporting is disabled');
  assert.equal(signal.aborted, false, 'an already sent request is not revoked');
  assert.equal(state.controlToken, TOKEN);
});
