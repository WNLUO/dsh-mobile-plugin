'use strict';
/** 2026-11-14 用户确认操作记录只复制，插件不再接收或写入该记录。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRouteTable } = require('./lib/wiring.cjs');
const permissions = require('../lib/mobile/permissions.js');

test('操作记录回传路由、权限与实现已移除', () => {
  const table = readRouteTable();
  assert.doesNotMatch(table, /perf-trace|perfTrace/);
  assert.equal(fs.existsSync(path.join(__dirname, '../lib/mobile/perf-trace.js')), false);
  assert.doesNotMatch(JSON.stringify(permissions), /perf-trace/);
});
