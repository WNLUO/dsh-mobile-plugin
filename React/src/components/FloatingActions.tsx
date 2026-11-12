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
    <>
      <JoinGroupButton compact={compact} />
      <SponsorButton compact={compact} />
      <StarButton compact={compact} />
    </>
  )
}
