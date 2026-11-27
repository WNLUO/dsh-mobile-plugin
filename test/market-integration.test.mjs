// dsh-featured 宿主半冒烟:桩 ctx + 桩 pluginManager/pluginMarket/credentials。
// 不依赖 DSH 进程,`node test/market-integration.test.mjs` 直接跑。
import assert from 'node:assert/strict'

const mod = await import('../lib/integrate-market.js')
const { integrateMarketIndex, MARKET_BUNDLE, FEATURED_INDEX_URL } = mod
const RECORD_KEY = 'dsh-mobile-plugin/market-integration'
const apply = (ctx) => integrateMarketIndex(ctx, 'dsh-mobile-plugin')
const name = 'dsh-mobile-plugin/integrate-market'

/* ── 桩:ctx / services ── */

function makeCtx({ bundlesEnabled = false, existingIndexes = [], flags = undefined, services = ['pluginManager', 'pluginMarket', 'credentials'] } = {}) {
  const effects = []
  const provided = new Map()
  const calls = { setBundleEnabled: [], setIndexes: [], modified: [] }
  let enabled = bundlesEnabled
  let indexes = [...existingIndexes]

  const pluginManager = {
    async listBundles() {
      return [{ name: MARKET_BUNDLE, enabled }]
    },
    async setBundleEnabled(bundle, on) {
      calls.setBundleEnabled.push([bundle, on])
      enabled = on
    },
  }
  const pluginMarket = {
    config: { indexes: { get: () => [...indexes] } },
    async setIndexes(urls) {
      if (new Set(urls).size !== urls.length) throw new Error('duplicate')
      calls.setIndexes.push([...urls])
      indexes = [...urls]
    },
  }
  const credentials = {
    async readRecord(key) {
      assert.equal(key, RECORD_KEY)
      return flags ? { payload: flags } : undefined
    },
    async modifyRecord(key, fn) {
      assert.equal(key, RECORD_KEY)
      const next = fn(undefined)
      flags = next.payload
      calls.modified.push({ ...flags })
    },
  }
  for (const s of services) provided.set(s, { pluginManager, pluginMarket, credentials }[s])

  const ctx = {
    effect(fn) {
      const dispose = fn() || (() => {})
      effects.push(dispose)
      return () => {}
    },
    get(k) {
      if (!provided.has(k)) throw new Error(`service not found: ${k}`)
      return provided.get(k)
    },
  }
  return { ctx, effects, calls, provided, getFlags: () => flags }
}

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

/* ── 用例 1:全新环境 → 启用 bundle + 追加索引源 + 记录状态 ── */
{
  const env = makeCtx()
  apply(env.ctx)
  assert.ok(await until(() => env.calls.setBundleEnabled.length > 0), '应调用 setBundleEnabled')
  assert.deepEqual(env.calls.setBundleEnabled[0], [MARKET_BUNDLE, true])
  assert.ok(await until(() => env.calls.setIndexes.length > 0), '应调用 setIndexes')
  assert.deepEqual(env.calls.setIndexes[0], [FEATURED_INDEX_URL])
  assert.ok(await until(() => env.getFlags()?.bundle === true && env.getFlags()?.source === true), '应记录集成状态')
  assert.equal(name, 'dsh-mobile-plugin/integrate-market')
  env.effects.forEach((d) => d())
}

/* ── 用例 2:索引源已存在 → 去重跳过,不重复添加 ── */
{
  const env = makeCtx({ bundlesEnabled: true, existingIndexes: [FEATURED_INDEX_URL, 'https://example.com/index.json'] })
  apply(env.ctx)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(env.calls.setIndexes.length, 0, '已存在时不得重复添加')
  assert.equal(env.calls.setBundleEnabled.length, 0, '已启用时不得重复切换')
  env.effects.forEach((d) => d())
}

/* ── 用例 3:凭据里已有完成标记 → 什么都不做(用户手动移除不被复活) ── */
{
  const env = makeCtx({ flags: { bundle: true, source: true } })
  apply(env.ctx)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(env.calls.setBundleEnabled.length, 0)
  assert.equal(env.calls.setIndexes.length, 0)
  env.effects.forEach((d) => d())
}

/* ── 用例 4:pluginMarket 未挂载 → 等挂载后再补加索引源 ── */
{
  const env = makeCtx({ bundlesEnabled: true, services: ['pluginManager', 'credentials'] })
  apply(env.ctx)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(env.calls.setIndexes.length, 0, 'market 未挂载时应等待')
  env.provided.set('pluginMarket', {
    config: { indexes: { get: () => [] } },
    async setIndexes(urls) { env.calls.setIndexes.push([...urls]) },
  })
  assert.ok(await until(() => env.calls.setIndexes.length > 0), '挂载后应补加')
  assert.deepEqual(env.calls.setIndexes[0], [FEATURED_INDEX_URL])
  env.effects.forEach((d) => d())
}

/* ── 用例 5:无官方 bundle(旧运行时) → 永久放弃,不报错 ── */
{
  const calls = { setBundleEnabled: [] }
  const effects = []
  const ctx = {
    effect(fn) { effects.push(fn() || (() => {})); return () => {} },
    get(k) {
      if (k === 'pluginManager') return { async listBundles() { return [] }, async setBundleEnabled(...a) { calls.setBundleEnabled.push(a) } }
      if (k === 'credentials') return { async readRecord() { return undefined }, async modifyRecord(k2, fn) { void fn } }
      throw new Error('missing ' + k)
    },
  }
  apply(ctx)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(calls.setBundleEnabled.length, 0, '无 bundle 不得切换')
  effects.forEach((d) => d())
}

console.log('dsh-mobile-plugin market-integration smoke: all cases passed')
