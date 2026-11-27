// integrate-market.js — SkillPie 插件索引集成模块(可直接复制进任意 DSH 插件)。
//
// 职责(一次性、幂等,详见 dsh-featured/AI-INTEGRATION.md 集成指引):
//   1. 自动启用官方「自定义插件索引」bundle(插件页「发现」tab 的提供方);
//   2. 幂等添加索引源 https://skillpie.cn/api/plugins/index.json(已存在即跳过)。
//
// 约定:只添加不回收——用户手动关掉开关或删掉索引源不会被复活;宿主插件
// 卸载不移除任何东西(索引源持久化在官方 pluginMarket 的 settings 用户段)。
// 多插件同时集成安全:添加前读当前列表去重,官方 setIndexes 自身再校验重复。
//
// 用法(宿主插件 lib/index.js 的 apply 里):
//   import { integrateMarketIndex } from './integrate-market.js'
//   apply(ctx) { integrateMarketIndex(ctx, 'dsh-termbar') ... }
// 第二个参数是凭据 scope(取包名短名,不含 /),用于记录「已集成过」。

/** 官方自定义插件索引 bundle 包名。 */
export const MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
/** plugin-market 服务在 profile 补丁层的条目 id(settings 通道写入目标)。 */
export const MARKET_ENTRY_ID = 'plugin-market'
/** SkillPie 精选插件索引源(DSH 插件市场索引 format 1)。 */
export const FEATURED_INDEX_URL = 'https://skillpie.cn/api/plugins/index.json'
/** 轮询间隔与上限:服务未就绪时重试,超过上限放弃到下次激活。 */
const TICK_MS = 1500
const MAX_TRIES = 60

export function integrateMarketIndex(ctx, scope) {
  const recordKey = `${scope}/market-integration`
  ctx.effect(() => {
    let disposed = false
    let busy = false
    let tries = 0
    let timer

    const schedule = () => {
      if (disposed) return
      tries += 1
      if (tries > MAX_TRIES) return
      void tick()
      timer = setTimeout(schedule, TICK_MS)
    }
    const tick = async () => {
      if (disposed || busy) return
      busy = true
      try { await integrate(ctx, recordKey) } catch { /* 下一轮重试或放弃 */ }
      busy = false
    }
    timer = setTimeout(schedule, 0)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, `${scope}: 索引集成(启用自定义插件索引 + 添加 SkillPie 索引源)`)
}

async function integrate(ctx, recordKey) {
  // 读取上次集成状态;无 credentials 服务时降级为「每次启动按状态补齐」。
  let flags = {}
  let credentials
  try {
    credentials = ctx.get('credentials')
    if (credentials) {
      const record = await credentials.readRecord(recordKey)
      if (record?.payload && typeof record.payload === 'object') flags = record.payload
    }
  } catch { flags = {} }

  if (flags.bundle && flags.source) return

  const pm = safeGet(ctx, 'pluginManager')
  if (!pm) return

  // 第 1 步:启用官方自定义插件索引 bundle。
  if (!flags.bundle) {
    const bundles = await pm.listBundles()
    const market = bundles.find((b) => b.name === MARKET_BUNDLE)
    if (!market) {
      // 运行环境没有官方 bundle(DSH 版本过旧):永久放弃,不产生副作用。
      flags = { bundle: true, source: true, absent: true }
    } else if (!market.enabled) {
      await pm.setBundleEnabled(MARKET_BUNDLE, true)
      flags.bundle = true
    } else {
      flags.bundle = true
    }
    await saveFlags(credentials, recordKey, flags)
    if (flags.absent) return
  }

  // 第 2 步:幂等添加 SkillPie 索引源。优先走 pluginMarket.setIndexes;
  // 但该服务挂在 plugin-market 插件自己的 cordis 上下文,兄弟插件 ctx.get
  // 不可见(实测) —— 此时退回 settings 通道:setIndexes 内部本就是
  // settings.update('plugin-market', { indexes })(归一化重复校验在写之前做,
  // 这里自行去重;URL 合法性由官方 normalizeIndexUrl 在插件页编辑时保证,
  // 我们只写本模块内固定常量)。两者都不可用 → 本轮返回下轮再试。
  if (!flags.source) {
    const market = safeGet(ctx, 'pluginMarket')
    if (market) {
      const current = market.config.indexes.get()
      if (!current.includes(FEATURED_INDEX_URL)) {
        await market.setIndexes([...current, FEATURED_INDEX_URL])
      }
    } else {
      const settings = safeGet(ctx, 'settings')
      const described = settings?.describe?.()
      const entry = Array.isArray(described)
        ? described.find((d) => d?.ns === MARKET_ENTRY_ID)
        : undefined
      const current = entry?.value?.indexes
      if (!Array.isArray(current)) return // settings 也不可用,下轮再试
      if (!current.includes(FEATURED_INDEX_URL)) {
        await settings.update(MARKET_ENTRY_ID, { indexes: [...current, FEATURED_INDEX_URL] })
      }
    }
    flags.source = true
    await saveFlags(credentials, recordKey, flags)
  }
}

function safeGet(ctx, service) {
  try { return ctx.get(service) } catch { return undefined }
}

async function saveFlags(credentials, recordKey, flags) {
  if (!credentials) return
  try {
    await credentials.modifyRecord(recordKey, () => ({ kind: 'grant', payload: flags }))
  } catch { /* 状态记录失败只影响「只做一次」,不影响幂等性 */ }
}
