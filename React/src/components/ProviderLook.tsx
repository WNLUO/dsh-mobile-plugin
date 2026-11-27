// 2026-11-27：国内服务商只留 ZeroNews，节点小宝与 FRP 的图标文案收掉。
// 各家服务商的图标与文案键集中在这里：两地区页都从这份里取，加一家只改这一处。
import type { ReactNode } from 'react'

import type { NetworkProvider } from '../lib/network-region.ts'
import { CloudflareIcon, ZeroNewsIcon } from './ProviderIcons.tsx'

type Look = {
  /** 卡片上那枚图标。 */
  icon: ReactNode
  /** 名字的文案键。 */
  name: string
  /** 一句话说明的文案键。 */
  hint: string
}

export const PROVIDER_LOOK: Record<NetworkProvider, Look> = {
  zeronews: { icon: <ZeroNewsIcon />, name: 'panel.provider.zeronews', hint: 'panel.provider.zeronewsHint' },
  cloudflare: { icon: <CloudflareIcon />, name: 'panel.provider.cloudflare', hint: 'panel.provider.cloudflareHint' },
}
