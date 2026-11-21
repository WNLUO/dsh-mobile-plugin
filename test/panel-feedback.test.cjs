// 验证插件反馈线程与脱敏连接事实，Tailcat 监听、启用和助手状态分别保留。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'React', 'src');
// typescript 是 React 的 devDependency：主仓开发时装了它，这几条测试照常转译 React/src 执行；
// 公开仓库单独检出只装插件根依赖、拿不到它（发版流水线就是这种检出），按仓库既有口径跳过，
// 与 remote-route-policy 在缺 app/ 时自我跳过同一处理。
let ts = null;
try {
  ts = createRequire(path.join(ROOT, 'React', 'package.json'))('typescript');
} catch {
  ts = null;
}
if (!ts) {
  test('面板反馈测试（单独检出未装 typescript，跳过）', { skip: 'standalone checkout without typescript' }, () => {});
  return;
}

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

function assertTailcatFacts(api) {
  const current = status();
  current.tailcat = {
    available: true, enabled: true, running: false, ready: false, paired: 0, targetPort: 40911,
    error: 'bind denied token=tailcat-private', address: 'tc-do-not-include',
    allowedClients: ['nodekey:do-not-include'],
  };
  const facts = api.connectionFeedbackFacts(current);
  assert.equal(facts.tailcat_available, 'true');
  assert.equal(facts.tailcat_enabled, 'true');
  assert.equal(facts.tailcat_running, 'false');
  assert.equal(facts.tailcat_ready, 'false');
  assert.equal(facts.tailcat_target_port, '40911');
  assert.equal(facts.tailcat_paired, '0');
  assert.equal(facts.tailcat_error, 'bind denied token=[redacted]');
  assert.doesNotMatch(JSON.stringify(facts), /tailcat-private|tc-do-not-include|nodekey:/);
  current.tailcat = { available: false, enabled: false, ready: false, paired: 0, targetPort: 0, error: '' };
  const unavailable = api.connectionFeedbackFacts(current);
  assert.equal(unavailable.tailcat_available, 'false');
  assert.equal(unavailable.tailcat_enabled, 'false');
  assert.equal(unavailable.tailcat_running, '', '旧门面缺 running 不能冒充 false');
  assert.equal(unavailable.tailcat_target_port, '0', '未监听与未知端口分开报告');
  for (const tailcat of [null, undefined]) {
    current.tailcat = tailcat;
    const missing = api.connectionFeedbackFacts(current);
    for (const field of ['available', 'enabled', 'running', 'ready', 'target_port', 'paired', 'error']) {
      assert.equal(missing[`tailcat_${field}`], '', `旧宿主缺 ${field} 不能伪造状态`);
    }
  }
}

test('Tailcat 诊断保留启用、监听端口与助手状态，缺失字段留空且不带地址和公钥', () => {
  assertTailcatFacts(load('feedback-diagnostics').api);
});

test('变异证明：删掉 Tailcat 诊断或把缺失状态伪装成关闭，同一断言必须失败', () => {
  for (const [before, after] of [
    ["    tailcat_enabled: String(status.tailcat?.enabled ?? ''),\n", ''],
    ["    tailcat_target_port: String(status.tailcat?.targetPort ?? ''),\n", ''],
    ["String(status.tailcat?.running ?? '')", "String(status.tailcat?.running ?? false)"],
    ['safeError(status.tailcat?.error)', 'status.tailcat?.error'],
  ]) {
    const broken = load('feedback-diagnostics', { mutate: source => {
      assert.equal(source.split(before).length, 2, '变异必须命中唯一实现');
      return source.replace(before, after);
    } });
    assert.throws(() => assertTailcatFacts(broken.api), { code: 'ERR_ASSERTION' });
  }
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
