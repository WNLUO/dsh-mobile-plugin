/**
 * 面板的「结果提示」统一走右上角的胶囊（Appica 的 toast）。
 *
 * 为什么不留在卡片里：卡片里那条 `Alert` 会一直占着版面，还把「刚才这件事成没成」和
 * 「这块的长期状态」混成一种东西。胶囊只管前者——出现一次，自己走掉。
 *
 * **长期状态不要改用胶囊**（这台宿主没有可换代的外壳、这台机器没有插件市场、`link:` 装的……
 * 那些是「一直如此」，卡片里写着才对；弹一次就消失等于让人再也看不到）。判断标准就一句：
 * 这句话是**某次动作的结果**还是**一个持续的事实**。
 */

import { useToastManager } from '@appica/ui-react/toast'
import { useCallback, useRef } from 'react'

export type NotifyTone = 'ok' | 'soft' | 'error'

/** 语气决定停留多久：故障要留够人看完，成功别赖着不走。 */
const TIMEOUT_MS: Record<NotifyTone, number> = {
  ok: 4000,
  soft: 6000,
  error: 9000,
}

/**
 * 弹一条提示。返回的函数身份**永远不变**。
 *
 * 为什么用 ref 兜一层：`useToastManager()` 返回的对象身份会随渲染变，直接拿它当
 * `useCallback` 的依赖，会让这个函数每次渲染都是新的；谁把它放进 `useEffect` 的依赖里，
 * 就会「effect 重跑 → 弹一条 → 重渲染 → effect 又重跑」转成死循环（2026-10-11 实测：
 * 页面直接白屏，控制台报 `Maximum update depth exceeded`，而且报在 `<ToastTitle>` 上，
 * 看着像是 toast 组件自己的毛病）。稳定身份把这个坑从调用方彻底拿走。
 */
export function useNotify(): (tone: NotifyTone, text: string) => void {
  const latest = useRef(useToastManager())
  latest.current = useToastManager()
  return useCallback((tone: NotifyTone, text: string) => {
    latest.current.add({
      title: text,
      type: tone,
      timeout: TIMEOUT_MS[tone],
      priority: tone === 'error' ? 'high' : 'low',
    })
  }, [])
}
