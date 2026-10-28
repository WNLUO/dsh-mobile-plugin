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
import { JoinGroupButton } from './components/JoinGroupButton.tsx'
import { NoticeBoard } from './components/NoticeBoard.tsx'
import { TopRightActions } from './components/TopRightActions.tsx'
import { usePanelLanguage } from './lib/i18n/use-language.ts'
import { Root } from './Root.tsx'

export function Shell() {
  // 订阅语言状态：换语言时这一层重渲，下面的页面跟着整棵重绘。
  usePanelLanguage()

  return (
    <>
      <Root />
      <TopRightActions />
      {/* 右下角那颗「加入交流群」：与右上角那组同理，**不属于任何一屏** ——
          2026-10-26 用户要求引导页也放一颗，与其在两页各挂一次（各写一个坐标、
          迟早错开），不如跟着外壳渲染一次。 */}
      <JoinGroupButton />
      {/* 左栏那块公告板：和上面两颗同理，两屏共用一份 —— 走公用中转的人在配对之前
          就该看见版本上限，等到进了主页才看见已经晚了。 */}
      <NoticeBoard />
    </>
  )
}
