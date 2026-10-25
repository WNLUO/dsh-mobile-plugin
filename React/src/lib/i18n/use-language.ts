/**
 * 把 `core.ts` 那份语言状态接进 React：组件里调 `usePanelLanguage()` 就会在换语言时重绘。
 *
 * 为什么单独一个文件而不是并进 `index.ts`：`index.ts` 是非组件代码（`lib/format.ts`、
 * 守卫）也在用的取词出口，那条路上不该顺手把 React 拖进来。这一层只有订阅一件事。
 *
 * 订阅只挂两处：页面外壳（`Shell.tsx`）与那颗语言按钮。外壳订阅之后整棵树跟着重绘 ——
 * 页面里所有文案都是渲染时 `t()` 查出来的，没有第二份缓存要清。
 */
import { useSyncExternalStore } from 'react'

import { panelLanguage, subscribePanelLanguage, type PanelLanguage } from './core.ts'

export function usePanelLanguage(): PanelLanguage {
  return useSyncExternalStore(subscribePanelLanguage, panelLanguage, panelLanguage)
}
