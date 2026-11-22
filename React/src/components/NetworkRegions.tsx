// 网络线路的两个地区入口：国内（中国）与国际（全球）。点开各自独立的页面，线路再多也不挤在这一页。
/**
 * 「按地区选线路」那两张卡。
 *
 * 为什么分地区而不是直接摊在同一页（2026-11-23 用户要求）：国内那几条线路只对国内用户有
 * 意义 —— 注册要国内手机号、节点也在国内；国际那条 Cloudflare 是匿名隧道，不用注册。两边
 * 的入口、说明、后续要加的线路都各走各的，摊在一起既长又互相干扰。
 *
 * 只做入口：点哪张卡，外层把 hash 换到那一页（见 Console 的 `#network/cn` / `#network/global`）。
 */
import { t } from '../lib/i18n/index.ts'
import type { NetworkRegion } from '../lib/network-region.ts'
import { ProviderCard } from './ProviderCard.tsx'

/** 国旗：红底 + 一颗大星四颗小星，画法取五星红旗那套比例，只看得出是哪个国家即可。 */
function ChinaFlag() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 shrink-0" aria-hidden="true">
      <defs>
        <path id="panel-region-star" d="M0-1 .2245-.309 .9511-.309 .3633 .118 .5878 .809 0 .382 -.5878 .809 -.3633 .118 -.9511-.309 -.2245-.309Z" fill="#ffde00" />
      </defs>
      <rect x="2" y="4" width="20" height="16" rx="2" fill="#de2910" />
      <use href="#panel-region-star" transform="translate(8 11.5) scale(3.1)" />
      <use href="#panel-region-star" transform="translate(13.4 7.6) scale(1.05)" />
      <use href="#panel-region-star" transform="translate(15.2 10) scale(1.05)" />
      <use href="#panel-region-star" transform="translate(15.2 13) scale(1.05)" />
      <use href="#panel-region-star" transform="translate(13.4 15.4) scale(1.05)" />
    </svg>
  )
}

/** 地球：一颗圆 + 一条经纬线，别画成「网络」那种抽象图标，它说的是「全球」。 */
function Globe() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3.5 12h17" />
    </svg>
  )
}

export function NetworkRegions({ onOpen }: { onOpen: (region: NetworkRegion) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground-strong">{t('panel.region.title')}</span>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ProviderCard
          icon={<ChinaFlag />}
          title={t('panel.region.china')}
          hint={t('panel.region.chinaHint')}
          onClick={() => onOpen('cn')}
        />
        <ProviderCard
          icon={<Globe />}
          title={t('panel.region.global')}
          hint={t('panel.region.globalHint')}
          onClick={() => onOpen('global')}
        />
      </div>
    </div>
  )
}
