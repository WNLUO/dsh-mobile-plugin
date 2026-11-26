// 网络线路的地址与互相跳转：网络配置主内容铺在首页，只有地区页 #network/cn|global 与
// 地区下面每家服务商各占一页（#network/cn/zeronews 之类）。
/**
 * 线路拆成两层（2026-11-23 用户要求）：地区页管「按地区选服务商」；地区页里再按服务商分页 ——
 * 后面加服务商只要往对应地区里加一页，既不会把首页撑长，也不用把别人家的配置摆在自家页面上。
 * 网络配置本身（中转 / 直连 / 局域网与 IPv6 / FRP）不再单独成页，直接铺在首页。
 *
 * 页面状态放在地址栏 hash 里，刷新、前进后退都还停在同一页 —— 不引路由库（面板产物是
 * 单文件，多一层依赖只为几个地址不值）。
 */
export type NetworkRegion = 'cn' | 'global'

/** 地区下的服务商。国内是 ZeroNews、节点小宝与 FRP，国际目前只有 Cloudflare。 */
export type NetworkProvider = 'zeronews' | 'jdxb' | 'frp' | 'cloudflare'

/** 面板当前停在哪一页。 */
export type NetworkPage = 'home' | NetworkRegion | ProviderPage

/** 服务商页的页面标识（地区/服务商）。写得实一点，别让类型放开到「国内 + Cloudflare」这种不存在的组合。 */
export type ProviderPage = 'cn/zeronews' | 'cn/jdxb' | 'cn/frp' | 'global/cloudflare'

/** 每家服务商属于哪个地区、页面标题用哪个键。 */
export const PROVIDERS: Record<NetworkProvider, { region: NetworkRegion }> = {
  zeronews: { region: 'cn' },
  jdxb: { region: 'cn' },
  frp: { region: 'cn' },
  cloudflare: { region: 'global' },
}

/** 页面 → 地址栏 hash 里的路径（不含 `#`，首页是空串）。 */
const PAGE_PATHS: Record<Exclude<NetworkPage, 'home'>, string> = {
  cn: 'network/cn',
  global: 'network/global',
  'cn/zeronews': 'network/cn/zeronews',
  'cn/jdxb': 'network/cn/jdxb',
  'cn/frp': 'network/cn/frp',
  'global/cloudflare': 'network/global/cloudflare',
}

const PATH_PAGES = new Map(Object.entries(PAGE_PATHS).map(([page, path]) => [path, page as NetworkPage]))

/** 地址栏 hash → 页面；认不出的 hash 一律回首页。 */
export function pageFromHash(hash: string): NetworkPage {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '')
  if (!path) return 'home'
  return PATH_PAGES.get(path) ?? 'home'
}

/** 页面 → 地址栏 hash（首页是空串）。 */
export function hashOfPage(page: NetworkPage): string {
  return page === 'home' ? '' : PAGE_PATHS[page]
}

/** 这一页是不是网络配置那一组（主配置页、地区页、服务商页都算）。 */
export function isNetworkPage(page: NetworkPage): boolean {
  return page !== 'home'
}

/** 服务商页 → 它所属的地区页（「返回」回这一层，不是直接回主配置页）。 */
export function regionOfPage(page: NetworkPage): NetworkRegion | null {
  if (page === 'cn' || page === 'global') return page
  if (page.includes('/')) return page.split('/')[0] as NetworkRegion
  return null
}

/** 服务商页 → 服务商；其它页回 null。 */
export function providerOfPage(page: NetworkPage): NetworkProvider | null {
  if (!page.includes('/')) return null
  return page.split('/')[1] as NetworkProvider
}

/** 某地区下的服务商（按展示顺序）。 */
export function providersOfRegion(region: NetworkRegion): NetworkProvider[] {
  return (Object.entries(PROVIDERS) as [NetworkProvider, { region: NetworkRegion }][])
    .filter(([, value]) => value.region === region)
    .map(([provider]) => provider)
}
