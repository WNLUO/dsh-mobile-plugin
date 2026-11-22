// 网络配置这一组页面的地址与互相跳转：主配置页 #network，地区子页 #network/cn、#network/global。
/**
 * 网络配置拆成三页（2026-11-23 用户要求）：主配置页管公用 / 自建中转、直连、局域网与 IPv6、
 * FRP；线路按地区分页，国内（ZeroNews、节点小宝）与国际（Cloudflare）各一页。
 *
 * 页面状态放在地址栏 hash 里，刷新、前进后退都还停在同一页 —— 与主配置页原来那条
 * `#network` 同一套口径，不引路由库（面板产物是单文件，多一层依赖只为三个地址不值）。
 *
 * 新增线路就加一个 region，不是往主配置页里再塞一段。
 */
export type NetworkRegion = 'cn' | 'global'

/** 面板当前停在哪一页：首页、网络配置、或某个地区子页。 */
export type NetworkPage = 'home' | 'network' | NetworkRegion

/** 地区子页对应的 hash（不带 `#`）。 */
const REGION_PATHS: Record<NetworkRegion, string> = { cn: 'network/cn', global: 'network/global' }

/** 地址栏 hash → 页面；认不出的 hash 一律回首页。 */
export function pageFromHash(hash: string): NetworkPage {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '')
  if (path === 'network') return 'network'
  for (const [region, value] of Object.entries(REGION_PATHS)) {
    if (path === value) return region as NetworkRegion
  }
  return 'home'
}

/** 页面 → 地址栏 hash（首页是空串）。 */
export function hashOfPage(page: NetworkPage): string {
  if (page === 'home') return ''
  if (page === 'network') return 'network'
  return REGION_PATHS[page]
}

/** 这一页是不是网络配置那一组（主配置页与两个地区子页都算）。 */
export function isNetworkPage(page: NetworkPage): boolean {
  return page !== 'home'
}
