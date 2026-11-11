/**
 * 页面右上角那一组按钮：界面语言 + 日间 / 夜间切换，**共用同一个落脚点**。
 *
 * 这一层存在的理由就是「同一个位置」：引导页（`Onboarding`）与进插件后的主页（`App`）
 * 是两块互不相关的界面，各自挂一遍就会各写一个坐标、迟早错开半个身位；这里由
 * `Shell.tsx` 在三张卡片之上渲染一次，两条路看到的是同一颗按钮、同一个位置。
 * 右下角那颗「加入交流群」是另一处（`JoinGroupButton`），别往这一组里塞。
 *
 * 悬浮层本身 `pointer-events-none`，只有按钮吃点击：这一层盖在页面顶部，整块吃点击
 * 等于把右上角那片内容点死。
 */
import { LanguageMenu } from './LanguageMenu.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

export function TopRightActions() {
  return (
    <div className="pointer-events-none fixed end-6 top-6 z-40 flex items-center gap-2">
      <LanguageMenu />
      <ThemeToggle />
    </div>
  )
}
