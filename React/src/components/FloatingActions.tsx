/**
 * 右下角那三颗悬浮胶囊：加入交流群 / 赞助 / 给个 Star。
 *
 * **只有一份实现**（2026-11-13 抽出来）：网页版外壳 `Shell` 与控制台的演示场景都要挂它，
 * 各写一遍必然两处各摆一个坐标、迟早错开。顺序从下往上是交流群 → 赞助 → Star（Star 最不
 * 打扰，顺手才点）。
 *
 * `compact` 是控制台那一窗用的小号（那一窗矮，原尺寸会压住设备列表最后几行）；位置也跟着
 * 收紧，见各组件自己那段说明。`hidden` 给调试页用：那一页是嵌在窗里读数字的，三颗会压到
 * 读数与操作按钮上。
 */
import { JoinGroupButton } from './JoinGroupButton.tsx'
import { SponsorButton } from './SponsorButton.tsx'
import { StarButton } from './StarButton.tsx'

type Props = {
  /** 小一号（控制台那一窗）。 */
  compact?: boolean
  /** 整组不挂（调试页）。 */
  hidden?: boolean
}

export function FloatingActions({ compact = false, hidden = false }: Props) {
  if (hidden) return null
  return (
    /*
      一个容器管三颗（2026-11-13）：坐标只写在这里一份，三颗各自不再自己钉 `fixed`。
      **贴窗口左侧**（`start-5`）+ 左对齐（`items-start`）：三颗宽度不一样
      （「加入交流群」「赞助」「给个 Star」），左对齐之后左边一条线，读起来也齐 ——
      用户 2026-11-13 明确要求摆到左边（上一版只把左边缘对齐、位置仍在右下角，
      在屏幕上看着没变化，等于没做）。
      `pointer-events-none` 只让按钮吃点击（整层吃点击会把底下的卡片点死）。
    */
    <div className={`pointer-events-none fixed start-5 z-40 flex flex-col items-start gap-2 ${compact ? 'bottom-4' : 'bottom-6'}`}>
      <StarButton compact={compact} />
      <SponsorButton compact={compact} />
      <JoinGroupButton compact={compact} />
    </div>
  )
}
