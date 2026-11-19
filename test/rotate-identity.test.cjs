'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('换身份：生成新实例号、保留旧号与历史密钥、配对码票据一起换', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rotate-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  delete require.cache[require.resolve('../lib/relay/core.js')];
  const core = require('../lib/relay/core.js');
  try {
    const state = core.defaultState();
    state.historyKey = 'HK-fixed-do-not-change';
    core.saveState(state);

    const oldId = state.instanceId;
    const result = core.rotateIdentity(state);

    // 新号是 128 位 / 32 位 hex，且确实换了。
    assert.match(result.instanceId, /^[0-9a-f]{32}$/);
    assert.notEqual(result.instanceId, oldId);
    // 旧号留在 previousInstanceId，过渡期鉴权要能同时认新旧。
    assert.equal(result.previousInstanceId, oldId);
    assert.equal(state.previousInstanceId, oldId);
    // HK 不动：控制载荷的解密不能因为换 id 而失效。
    assert.equal(state.historyKey, 'HK-fixed-do-not-change');
    // 配对码仍是 6 位数字。
    assert.match(state.pairingCode, /^\d{6}$/);

    // 落盘后重新读回：新号、旧号、HK 都在。
    const reloaded = core.loadState();
    assert.equal(reloaded.instanceId, result.instanceId);
    assert.equal(reloaded.previousInstanceId, oldId);
    assert.equal(reloaded.historyKey, 'HK-fixed-do-not-change');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
