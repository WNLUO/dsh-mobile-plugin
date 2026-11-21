/**
 * 面板的页面外壳：把「引导页 / 主页」和右上角那组按钮放在一起，**两个入口共用这一份**。
 *
 * 两条理由：
 *  1. **同一处按钮**：语言与日夜切换不属于任何一屏，引导页和进插件后的主页都得看得见、
 *     而且必须落在同一个位置（用户 2026-10-26 要求）。所以它们不挂在 `App` / `Onboarding`
 *     里，而是挂在这一层。
 *  2. **切语言要整页重绘**：页面里所有文案都是渲染时 `t()` 查出来的，没有任何一份缓存，
 *     所以只要这一层订阅到语言变了、往下重渲一次就够。⚠️ 订阅必须写在**造 `<Root />`
 *     的那个组件里**：如果把重绘想成「父组件重渲染、子元素是同一个对象」，React 会因为
 *     元素引用没变而整棵子树跳过，语言就换不动了。
 *
 * 两个入口（`main.tsx` 与 `demo/main.tsx`）都渲染这一个组件，别各写一份。
 */
import { useEffect } from 'react'

import { TopRightActions } from './components/TopRightActions.tsx'
import { t } from './lib/i18n/index.ts'
import { usePanelLanguage } from './lib/i18n/use-language.ts'
import { watchEmbedVisibility } from './lib/embed-visibility.ts'
import { watchShellTheme } from './lib/shell-theme.ts'
import { Root } from './Root.tsx'

export function Shell() {
  // 订阅语言状态：换语言时这一层重渲，下面的页面跟着整棵重绘。
  const language = usePanelLanguage()
  // 浏览器标签页上那行字与 `<html lang>` 也归语言管：标题写死在 HTML 里的话，切到英文
  // 标签页还叫中文；`lang` 不对，读屏软件会按中文的调读德语，断词和朗读都是错的。
  // 只改这两处，版式一个像素都不动。
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.lang = language
    document.title = t('panel.shell.title')
  }, [language])
  const path = window.location.pathname.replace(/\/+$/, '')
  // 除演示页外，面板的每一条地址都是控制台这一版（2026-11-15 收成一套，2026-11-17 删掉
  // 唯一的例外调试页）：配色跟 DSH 走、用控制台顶栏自带的语言 / 日夜。Star / 赞助 / 交流群
  // 三颗 2026-11-17 也进了顶栏（Console 的 header），外壳不再全局挂任何悬浮按钮。
  // 演示页（`/demo.html`）不在这里面，它有自己的假宿主与录屏用法，保持原样。
  const consolePage = !/\/demo(\.html)?$/.test(path)

  // 控制台那一窗的日夜**跟着 DSH 走**（同源父窗口的 `data-ds-dark-theme`），
  // 单独在浏览器里打开就跟随系统。别的页不接：那几页有自己的日夜按钮，两套一起写
  // `<html>` 上的 class 会互相打架。见 `lib/shell-theme.ts`。
  useEffect(() => {
    if (!consolePage) return undefined
    return watchShellTheme()
  }, [consolePage])

  // 被嵌在 DSH 那一窗里时，收起后父窗口会让这一页「停下来」（见 `lib/embed-visibility.ts`）：
  // 那一窗收起不销毁，页内轮询得跟着停，用户才会感到「关掉就恢复」。
  useEffect(() => watchEmbedVisibility(), [])

  return (
    <>
      <Root />
      {/* 右上角那组（语言 + 日夜）：**控制台那一窗不挂**（2026-11-13 用户要求把它们放进
          顶栏、跟着窗口标题排），它自己那两行里就有同样两颗。演示页照旧。 */}
      {consolePage ? null : <TopRightActions />}
      {/* Star / 赞助 / 交流群三颗 2026-11-17 挪进了顶栏左侧（Console 的 header 里），
          不再由外壳全局悬浮挂载。 */}
    </>
  )
}
