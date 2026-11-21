// 执行更新卡真实 hooks，验证版本快照重读、磁盘比较及迟到响应的回归和变异。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.join(__dirname, '..');
const REACT = path.join(ROOT, 'React');
let ts = null;
try { ts = createRequire(path.join(REACT, 'package.json'))('typescript'); } catch { /* 单独检出可能未装面板开发依赖。 */ }
if (!ts) {
  test('更新卡版本测试（未装 typescript，跳过）', { skip: 'standalone checkout without typescript' }, () => {});
  return;
}
const CARD = path.join(REACT, 'src/components/UpdateCard.tsx');
const SOURCE = fs.readFileSync(CARD, 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (version, installedVersion = version) => ({ available: true, version, installedVersion, swapping: false });

/** 沿用面板组件测试的 VM/hooks 假体，依赖比较与 effect 清理按 React 顺序执行。 */
function card(mutate = (source) => source, check = async () => ({ update: null, status: null })) {
  let cursor = 0;
  const slots = [];
  let effects = [];
  const reads = [];
  let issues = [];
  const onIssues = (next) => { issues = next; };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], (next) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }];
    },
    useRef(initial) { const at = cursor++; return slots[at] ||= { current: initial }; },
    useCallback(fn, deps) {
      const at = cursor++;
      if (!same(slots[at]?.deps, deps)) slots[at] = { deps, fn };
      return slots[at].fn;
    },
    useEffect(fn, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (!same(previous?.deps, deps)) effects.push(() => {
        previous?.cleanup?.();
        slots[at] = { deps, cleanup: fn() };
      });
    },
  };
  const module = { exports: {} };
  const input = mutate(SOURCE);
  const code = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const ui = new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : key });
  vm.runInNewContext(code, {
    module, exports: module.exports,
    window: { setInterval: () => 1, clearInterval() {} },
    require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
      if (id.includes('relayUpdate.ts')) return {
        updateStatus: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
        updateCheck: check,
        updateUnavailable: (error) => error.code === 'update_unavailable',
        updateEndpointMissing: () => false,
      };
      if (id.includes('i18n/index.ts')) return { t: (key, params) => key + (params ? ':' + JSON.stringify(params) : '') };
      if (id.includes('notify.ts')) return { useNotify: () => () => {} };
      if (id.includes('market.ts')) return { marketCapabilities: async () => ({ available: false }) };
      return ui;
    },
  }, { filename: CARD });
  return {
    reads,
    get issues() { return issues; },
    async paint(version) {
      for (let pass = 0; pass < 3; pass++) {
        cursor = 0; effects = [];
        module.exports.UpdateCard({ version, busy: '', onRestartSidecar() {}, onIssues, bare: true });
        const pending = effects; effects = [];
        for (const effect of pending) effect();
        await settle();
      }
    },
  };
}

async function mainLeadsContract(mutate) {
  const env = card(mutate);
  await env.paint('0.5.87');
  env.reads[0].resolve(snapshot('0.5.87'));
  await env.paint('0.5.87');
  assert.equal(env.issues.length, 0);
  await env.paint('0.5.90');
  assert.equal(env.reads.length, 2, '主状态变版后必须再读外壳，不能一直保留首屏快照');
  env.reads[1].resolve(snapshot('0.5.90'));
  await env.paint('0.5.90');
  assert.equal(env.issues.length, 0, '后台换代完成后两份快照应收敛');
}
test('主状态先看到新版：常驻更新卡重读外壳并清除旧快照', () => mainLeadsContract());
test('变异：移除主版本依赖会被后台换代回归拒绝', async () => {
  await assert.rejects(mainLeadsContract((source) => source.replace('}, [loadHost, version])', '}, [loadHost])')), assert.AssertionError);
});

async function shellLeadsContract(mutate) {
  const env = card(mutate);
  await env.paint('0.5.87');
  env.reads[0].resolve(snapshot('0.5.90'));
  await env.paint('0.5.87');
  assert.equal(env.issues.length, 1, '面板旧快照不应被误报为磁盘安装未完成');
  assert.equal(env.issues[0].title, 'panel.update.runningVersion');
  await env.paint('0.5.90');
  env.reads[1].resolve(snapshot('0.5.90'));
  await env.paint('0.5.90');
  assert.equal(env.issues.length, 0);
}
test('外壳先看到新版：面板旧快照只报读取差异，主状态追上后清除', () => shellLeadsContract());
test('变异：磁盘改回比较面板版会被快照误报回归拒绝', async () => {
  await assert.rejects(shellLeadsContract((source) => source.replace(
    'const diskDisagree = hostMode && !!diskVersion && !!shellVersion && diskVersion !== shellVersion',
    'const diskDisagree = hostMode && !!diskVersion && !!version && diskVersion !== version',
  )), assert.AssertionError);
});

async function diskContract(mutate) {
  const env = card(mutate);
  await env.paint('0.5.87');
  env.reads[0].resolve(snapshot('0.5.88', '0.5.90'));
  await env.paint('0.5.87');
  const disk = env.issues.find((issue) => issue.title === 'panel.update.diskVersion');
  assert.ok(disk, '磁盘与外壳确实不同仍应报告');
  assert.match(disk.detail, /"running":"0\.5\.88"/, '磁盘差异文案必须使用实际外壳版');
  assert.doesNotMatch(disk.detail, /0\.5\.87/);
}
test('真实磁盘差异继续提示，实际运行版本取外壳快照', () => diskContract());
test('变异：磁盘提示改回面板版会被实际版本回归拒绝', async () => {
  await assert.rejects(diskContract((source) => source.replace(
    "running: shellVersion ?? ''", "running: version ?? ''",
  )), assert.AssertionError);
});

async function lateReadContract(mutate, rejectOld = false) {
  const env = card(mutate);
  await env.paint('0.5.87');
  await env.paint('0.5.90');
  assert.equal(env.reads.length, 2);
  env.reads[1].resolve(snapshot('0.5.90'));
  await env.paint('0.5.90');
  if (rejectOld) env.reads[0].reject({ code: 'update_unavailable' });
  else env.reads[0].resolve(snapshot('0.5.87'));
  await env.paint('0.5.90');
  assert.equal(env.issues.length, 0, '迟到的旧读取不得覆盖新版快照');
  if (rejectOld) {
    await env.paint('0.5.91');
    env.reads[2].resolve(snapshot('0.5.90'));
    await env.paint('0.5.91');
    assert.equal(env.issues.length, 1, '旧失败不能把新版错误降级成没有外壳');
  }
}
test('先发后到的旧状态响应不能覆盖新读取', () => lateReadContract());
test('先发后到的旧读取失败不能抹掉外壳状态', () => lateReadContract(undefined, true));
test('变异：移除读取序号保护会被迟到响应回归拒绝', async () => {
  await assert.rejects(lateReadContract((source) => source.replaceAll('if (read !== hostRead.current) return', '')), assert.AssertionError);
});

async function lateCheckContract(mutate) {
  let resolveCheck;
  const env = card(mutate, () => new Promise((resolve) => { resolveCheck = resolve; }));
  await env.paint('0.5.87');
  env.reads[0].resolve(snapshot('0.5.87'));
  await env.paint('0.5.87');
  await env.paint('0.5.90');
  env.reads[1].resolve(snapshot('0.5.90'));
  await env.paint('0.5.90');
  resolveCheck({ update: null, status: snapshot('0.5.87') });
  await env.paint('0.5.90');
  assert.equal(env.issues.length, 0, '等待注册表期间保存的旧检查快照不能覆盖新版');
}
test('静默检查晚到时不能把后台换代后的状态改回旧版', () => lateCheckContract());
test('变异：放行旧检查快照会被迟到检查回归拒绝', async () => {
  await assert.rejects(lateCheckContract((source) => source.replaceAll(
    'if (result.status && read === hostRead.current)', 'if (result.status)',
  )), assert.AssertionError);
});
