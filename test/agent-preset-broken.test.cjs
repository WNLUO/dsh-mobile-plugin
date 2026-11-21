/** 预设异常原因穿过移动 API，并在默认写入前拦截坏档。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { handleAgentPresets } = require('../lib/mobile/session-presets.js');
const { handleAgentPresetDefault } = require('../lib/mobile/agent-presets.js');
const reason = 'tool-web (@deepseek-ai/dsh-tool-web): missing search service';
function runtime(presets) {
  const writes = [];
  return { writes, apiProxy: {
    agentPresets: { list: async () => ({ result: { ok: true, value: { presets, authorable: 'yes' } } }) },
    settings: { mutate: async (request) => { writes.push(request); return { result: { ok: true, value: {} } }; } },
  } };
}
async function call(handler, ctx, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  req.headers = {}; req.url = '/api/mobile/v1/agent-presets';
  const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  await handler(ctx, req, res);
  return res;
}
async function listContract(handler) {
  const ctx = runtime([{ id: 'standard', isDefault: true, broken: reason }, { id: 'legacy', broken: true },
    { id: 'empty', broken: '  ' }, { id: 'false', broken: false }, { id: 'number', broken: 1 }]);
  const res = await call(handler, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.body.presets[0].broken, reason, '宿主诊断原因必须原样保留');
  assert.equal(res.body.presets[0].trust, 'system', '声明版缺 trust 仍是随附预设');
  assert.equal(res.body.presets[1].broken, true);
  for (const item of res.body.presets.slice(2)) assert.equal(Object.hasOwn(item, 'broken'), false);
  assert.equal(res.body.authorable, false, '其它布尔字段仍严格收窄');
  return res;
}
async function defaultContract(handler) {
  for (const broken of [reason, true]) {
    // 已经被宿主标成默认的坏档也不能假报设置成功。
    const ctx = runtime([{ id: 'standard', broken, isDefault: true }]);
    const res = await call(handler, ctx, { agentPreset: 'standard' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'agent-preset-invalid');
    assert.match(res.body.error.message, /加载失败/);
    assert.equal(res.body.error.details.agentPreset, 'standard');
    assert.equal(res.body.error.details.reason, typeof broken === 'string' ? broken : undefined);
    assert.equal(ctx.writes.length, 0);
  }
}
function mutant(relative, before, after) {
  const file = require.resolve(relative);
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(before), `变异点未命中：${before}`);
  const module = { exports: {} };
  vm.runInNewContext(source.replace(before, after), { module, exports: module.exports, require: createRequire(file) });
  return module.exports;
}
test('列表保留新诊断和旧状态，不误判空诊断或其它类型', () => listContract(handleAgentPresets));
test('异常原因变化推进现有名单 revision', async () => {
  const first = await call(handleAgentPresets, runtime([{ id: 'standard', broken: reason }]));
  const second = await call(handleAgentPresets, runtime([{ id: 'standard', broken: 'tool-fs: import failed' }]));
  assert.notEqual(first.body.revision, second.body.revision);
});
test('坏档不能设置默认，包括宿主已将它标成默认时', () => defaultContract(handleAgentPresetDefault));
test('好档可写默认，旧布尔 false 和空诊断不挡住', async () => {
  for (const broken of [undefined, false, '', '  ', 1]) {
    const ctx = runtime([{ id: 'minimal', broken }]);
    const res = await call(handleAgentPresetDefault, ctx, { agentPreset: 'minimal' });
    assert.equal(res.status, 200);
    assert.equal(ctx.writes[0].payload.ops[0].value, 'minimal');
  }
});
test('变异证明：丢诊断、放行坏档都会被相同行为断言拒绝', async () => {
  const list = mutant('../lib/mobile/session-presets.js', "typeof item.broken === 'string' && item.broken.trim()", 'false');
  await assert.rejects(() => listContract(list.handleAgentPresets), assert.AssertionError);
  const defaults = mutant('../lib/mobile/agent-presets.js', 'row.broken === true || reason !== undefined', 'false');
  await assert.rejects(() => defaultContract(defaults.handleAgentPresetDefault), assert.AssertionError);
});
