// 三家服务商的图标与文案键集中在这里：两地区页都从这份里取，加一家只改这一处。
import type { ReactNode } from 'react'

import type { NetworkProvider } from '../lib/network-region.ts'
import { CloudflareIcon, JdxbIcon, ZeroNewsIcon } from './ProviderIcons.tsx'

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
  jdxb: { icon: <JdxbIcon />, name: 'panel.provider.jdxb', hint: 'panel.provider.jdxbHint' },
  cloudflare: { icon: <CloudflareIcon />, name: 'panel.provider.cloudflare', hint: 'panel.provider.cloudflareHint' },
}
