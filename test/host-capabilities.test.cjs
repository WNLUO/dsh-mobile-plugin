'use strict'

/**
 * `lib/host-capabilities.cjs`：这一次启动「少挂了什么」的记录。
 *
 * 为什么值得单独钉：它是那条静默降级路线上唯一会说人话的东西。宿主解析不到同代的官方
 * 工具时不会失败——照样起来、手机照样连上，只是某个工具不见了，模型只会说「不可用」。
 * 这份记录由 `/api/mobile/v1/status` 报给手机，App 才能明说。所以这里钉两件事：
 * **没跑过对齐时是 null 而不是空数组**（「没检查」≠「检查了没问题」），以及
 * **落账的内容不会被写坏**（未知 reason 归到默认那一档，脏条目丢掉）。
 *
 * 运行：node --test test/host-capabilities.test.cjs
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  setCapabilityReport,
  readCapabilityReport,
  resetCapabilityReportForTests,
} = require('../lib/host-capabilities.cjs')

test('没跑过对齐时报 null：没检查和检查了没问题不是一件事', () => {
  resetCapabilityReportForTests()
  assert.equal(readCapabilityReport(), null)
})

test('对齐过、什么都没少，报一个带空 missing 的对象', () => {
  resetCapabilityReportForTests()
  setCapabilityReport({ runtimeVersion: '0.2.2-rc.1', missing: [] })
  assert.deepEqual(readCapabilityReport(), { runtimeVersion: '0.2.2-rc.1', missing: [] })
})

test('缺的行原样记下，reason 只认两档', () => {
  resetCapabilityReportForTests()
  setCapabilityReport({
    runtimeVersion: '0.2.2-rc.1',
    missing: [
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', reason: 'no-compatible-generation' },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents', reason: 'entry-removed' },
      // 未知 reason 归到「没解析到同代的一份」——那是更常见的脚，报错方向更保守。
      { id: 'tool-present', name: '@deepseek-ai/dsh-tool-present', reason: 'some-new-reason' },
    ],
  })
  const report = readCapabilityReport()
  assert.equal(report.runtimeVersion, '0.2.2-rc.1')
  assert.deepEqual(report.missing.map((item) => item.reason), [
    'no-compatible-generation',
    'entry-removed',
    'no-compatible-generation',
  ])
})

test('脏条目丢掉，不让一份坏数据把整条状态接口带垮', () => {
  resetCapabilityReportForTests()
  setCapabilityReport({
    runtimeVersion: 42,
    missing: [null, 'oops', { name: '没有 id 就不算' }, { id: 'tool-ask-user' }],
  })
  assert.deepEqual(readCapabilityReport(), {
    runtimeVersion: null,
    // 只有最后那条带 id 的留下；name 缺了给 null，不让 App 拿到 undefined。
    missing: [{ id: 'tool-ask-user', name: null, reason: 'no-compatible-generation' }],
  })
})

test('缺 missing 字段时当「什么都没少」，不是 null', () => {
  resetCapabilityReportForTests()
  setCapabilityReport({ runtimeVersion: '0.2.2-rc.1' })
  assert.deepEqual(readCapabilityReport(), { runtimeVersion: '0.2.2-rc.1', missing: [] })
})

test('记录只增不减：后一次对齐不会把前一次擦成 null', () => {
  resetCapabilityReportForTests()
  setCapabilityReport({ runtimeVersion: '0.2.2-rc.1', missing: [{ id: 'a', name: 'b' }] })
  setCapabilityReport({ runtimeVersion: '0.2.2-rc.1', missing: [] })
  assert.deepEqual(readCapabilityReport().missing, [], '重载一代之后应当按最新那次对齐报')
})
