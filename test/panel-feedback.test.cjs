// 验证插件反馈的脱敏连接事实：Tailcat 监听、启用和助手状态分别保留。
// 面板的「我的反馈」历史界面已按需求下线（2026-11-21 用户要求），这里同时钉住它不再回潮。
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
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URL, Date, Event,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { dispatchEvent: () => {} },
    require: () => ({}),
  }, { filename: file });
  return { api: module.exports };
}

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

test('镜像 ok=true 的良性跳过不算镜像错误，只有 ok=false 才上报原因', () => {
  const current = status();
  current.mirror = { ok: true, error: '内容未变，跳过重复推送' };
  assert.equal(load('feedback-diagnostics').api.connectionFeedbackFacts(current).mirror_error, '');
  current.mirror = { ok: false, error: 'push timeout' };
  assert.equal(load('feedback-diagnostics').api.connectionFeedbackFacts(current).mirror_error, 'push timeout');
});

test('变异证明：镜像不看 ok 只看 error，良性跳过会被误报成镜像错误', () => {
  const broken = load('feedback-diagnostics', { mutate: source => {
    const before = "mirror_error: status.mirror.ok === false ? safeError(status.mirror.error) : '',";
    assert.equal(source.split(before).length, 2, '变异必须命中唯一实现');
    return source.replace(before, 'mirror_error: safeError(status.mirror.error),');
  } });
  const current = status();
  current.mirror = { ok: true, error: '内容未变，跳过重复推送' };
  assert.throws(() => assert.equal(broken.api.connectionFeedbackFacts(current).mirror_error, ''), { code: 'ERR_ASSERTION' });
});

test('面板不再有「我的反馈」历史入口与弹窗（2026-11-21 用户要求下线）', () => {
  const source = name => fs.readFileSync(path.join(SRC, name), 'utf8');
  const gone = ['components/FeedbackInbox.tsx', 'components/FeedbackButton.tsx', 'lib/feedback.ts', 'lib/i18n/messages/feedback.ts'];
  for (const name of gone) {
    assert.equal(fs.existsSync(path.join(SRC, name)), false, `${name} 应已删除`);
  }
  assert.doesNotMatch(source('Shell.tsx'), /FeedbackInbox/, '外壳不该再挂反馈弹窗');
  assert.doesNotMatch(source('components/FloatingActions.tsx'), /FeedbackButton/, '控制台顶栏不该再有反馈入口');
  assert.doesNotMatch(source('Onboarding.tsx'), /FeedbackButton|rememberFeedbackThread/, '引导页不该再有反馈历史入口');
  assert.doesNotMatch(source('components/IssueMark.tsx'), /FeedbackButton|rememberFeedbackThread/, '报错卡片不该再连反馈历史');
  assert.doesNotMatch(source('lib/i18n/index.ts'), /FEEDBACK/, '字典不该再登记反馈历史文案');
  // 就地提交反馈（回执 + 复制编号）仍在，别被这条一起删掉。
  assert.match(source('components/IssueMark.tsx'), /panel\.feedback\.receipt/);
  assert.match(source('Onboarding.tsx'), /panel\.feedback\.receipt/);
});

test('变异证明：错误脱敏被去掉会被回归发现', () => {
  const brokenFacts = load('feedback-diagnostics', { mutate: source => source.replace(".replace(/\\b(token|secret|key|password|passwd|lansecret|pairingcode|signingkey|registrykey)\\s*=\\s*[^\\s,;&\"'）)]+/gi, '$1=[redacted]')", '') });
  assert.throws(() => assert.doesNotMatch(JSON.stringify(brokenFacts.api.connectionFeedbackFacts(status())), /private/));
});
