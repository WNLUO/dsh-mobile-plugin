// 验证插件反馈能保存编号、查看原线程、继续回复，并携带固定连接事实而非凭据。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'React', 'src');
const ts = createRequire(path.join(ROOT, 'React', 'package.json'))('typescript');

function load(name, options = {}) {
  const file = path.join(SRC, 'lib', name + '.ts');
  const source = fs.readFileSync(file, 'utf8');
  const input = options.mutate ? options.mutate(source) : source;
  const compiled = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const saved = options.saved || new Map();
  const events = [];
  const calls = [];
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URL, Date, Event,
    CustomEvent: class extends Event { constructor(type, init) { super(type); this.detail = init.detail; } },
    localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
    window: { dispatchEvent: event => events.push(event) },
    require: () => ({
      apiGet: async url => { calls.push({ method: 'GET', url }); return { thread_key: 'key', status: 'open', messages: [] }; },
      apiPost: async (url, body) => { calls.push({ method: 'POST', url, body }); return { threadKey: body.threadKey }; },
    }),
  }, { filename: file });
  return { api: module.exports, saved, events, calls };
}

test('反馈编号持久保存、同一线程去重，重新加载后仍可打开', () => {
  const { api, saved, events } = load('feedback');
  api.rememberFeedbackThread('key-a', '中转连接失败\n522');
  api.rememberFeedbackThread('key-b', '局域网发现超时');
  api.rememberFeedbackThread('key-a', '中转连接失败');
  const reloaded = load('feedback', { saved }).api.savedFeedbackThreads();
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[0].key, 'key-a');
  assert.equal(reloaded[0].title, '中转连接失败');
  assert.equal(events.length, 3);
  assert.ok(![...saved.values()].join('').includes('522'), '只存标题与编号，不缓存反馈正文');
});

test('查看及续回复始终使用同一反馈编号，编号作查询值编码', async () => {
  const { api, calls, events } = load('feedback');
  await api.readFeedbackThread('key&x=1');
  await api.replyFeedbackThread('key&x=1', '中转是公用线路');
  assert.equal(calls[0].url, '/api/relay/feedback?thread_key=key%26x%3D1');
  assert.equal(calls[1].body.threadKey, 'key&x=1');
  assert.equal(calls[1].body.content, '中转是公用线路');
  api.openFeedbackThread('key&x=1');
  assert.equal(events[0].type, api.FEEDBACK_OPEN);
  assert.equal(events[0].detail, 'key&x=1');
});

function status() {
  return {
    appVersion: '0.5.88', platform: 'win32', osVersion: '10',
    instanceId: 'do-not-include-instance', pairingCode: '123456', lanSecret: 'do-not-include-secret',
    relayUrl: 'https://user:password@relay.example.com:8443/tunnel?token=private',
    tunnel: { state: 'error', error: 'Unexpected server response: 522 token=private' },
    lan: { state: 'listening', port: 18787, error: null, discovery: { state: 'error', error: '发布超时' } },
    sidecar: { state: 'healthy', restartError: null }, mirror: { error: '隧道未连接' },
  };
}

test('连接诊断保留版本、域名和线路状态，只投影固定字段并脱敏错误', () => {
  const facts = load('feedback-diagnostics').api.connectionFeedbackFacts(status());
  assert.equal(facts.relay_host, 'relay.example.com:8443');
  assert.equal(facts.tunnel_state, 'error');
  assert.equal(facts.lan_state, 'listening');
  assert.equal(facts.discovery_error, '发布超时');
  assert.equal(facts.plugin_version, '0.5.88');
  assert.match(facts.tunnel_error, /522/);
  assert.match(facts.tunnel_error, /token=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(facts), /private|password|123456|do-not-include/);
});

test('入口接通：提交保存编号，引导与控制台可重开；补充成功后才清草稿', () => {
  const source = name => fs.readFileSync(path.join(SRC, name), 'utf8');
  assert.match(source('components/IssueMark.tsx'), /rememberFeedbackThread\(threadKey, draft\.summary\)/);
  assert.match(source('components/IssueMark.tsx'), /<FeedbackButton threadKey=\{threadKey\}/);
  assert.match(source('components/FloatingActions.tsx'), /<FeedbackButton/);
  assert.match(source('Onboarding.tsx'), /<FeedbackButton/);
  assert.match(source('Shell.tsx'), /<FeedbackInbox \/>/);
  assert.match(source('components/FeedbackInbox.tsx'), /await replyFeedbackThread\(target, content\)[\s\S]*?setDrafts/);
  assert.match(source('components/ConnectionCard.tsx'), /facts: connectionFeedbackFacts\(status\)/);
  assert.match(source('components/FeedbackInbox.tsx'), /DialogBody className="[^"]*overflow-y-auto/);
  assert.match(source('components/IssueMark.tsx'), /feedbackFor === summary && threadKey/);
  assert.match(source('Onboarding.tsx'), /const key = sameIssue \? feedbackKeys\[slot\]/);
});

test('变异证明：去掉编号持久化或错误脱敏会被对应回归发现', () => {
  const brokenStore = load('feedback', { mutate: source => source.replace('localStorage.setItem(STORAGE_KEY, JSON.stringify([row, ...current.filter((item) => item.key !== key)]))', '') });
  brokenStore.api.rememberFeedbackThread('key-a', '中转');
  assert.throws(() => assert.equal(brokenStore.api.savedFeedbackThreads().length, 1));
  const brokenFacts = load('feedback-diagnostics', { mutate: source => source.replace(".replace(/\\b(token|secret|key|password|passwd|lansecret|pairingcode|signingkey|registrykey)\\s*=\\s*[^\\s,;&\"'）)]+/gi, '$1=[redacted]')", '') });
  assert.throws(() => assert.doesNotMatch(JSON.stringify(brokenFacts.api.connectionFeedbackFacts(status())), /private/));
});
