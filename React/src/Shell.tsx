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

import { JoinGroupButton } from './components/JoinGroupButton.tsx'
import { SponsorButton } from './components/SponsorButton.tsx'
import { StarButton } from './components/StarButton.tsx'
import { TopRightActions } from './components/TopRightActions.tsx'
import { t } from './lib/i18n/index.ts'
import { usePanelLanguage } from './lib/i18n/use-language.ts'
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
  // 调试页是嵌在 DSH 那个弹窗里的一窗（宽约一千），右上角那组「日夜 / 语言」与右下角
  // 「加入交流群」都会压到读数或那排操作按钮上；它们是给「人从浏览器打开这一页」准备的，
  // 调试图不挂。主题跟随系统，够用。
  const debugPage = window.location.pathname.replace(/\/+$/, '').endsWith('/debug')

  return (
    <>
      <Root />
      {debugPage ? null : <TopRightActions />}
      {/* 右下角那颗「加入交流群」：与右上角那组同理，**不属于任何一屏** ——
          2026-10-26 用户要求引导页也放一颗，与其在两页各挂一次（各写一个坐标、
          迟早错开），不如跟着外壳渲染一次。 */}
      {debugPage ? null : <JoinGroupButton />}
      {/* 「赞助」排在群按钮上面一格：同属右下角那串悬浮件，调试图同样不挂。 */}
      {debugPage ? null : <SponsorButton />}
      {/* 「给个 Star」再上移一格（`bottom-[10.5rem]`）：三颗同一串，从下往上是交流群 /
          赞助 / 这颗。求 star 是这个仓库最实在的支持，但它排在人家已经愿意掏钱的那颗
          上面一格、最不打扰的位置——顺手才点，不点也不挡任何事。 */}
      {debugPage ? null : <StarButton />}
    </>
  )
}
