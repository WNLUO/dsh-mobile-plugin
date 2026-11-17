/**
 * 顶栏左侧那排附属按钮：给个 Star / 赞助 / 加入交流群。
 *
 * **只有一份实现**（2026-11-13 抽出，2026-11-17 从悬浮改顶栏）：外壳 `Shell` 与控制台
 * 演示场景都要挂它，各写一遍必然两处各摆一个坐标、迟早错开。顺序从左到右是
 * Star → 赞助 → 交流群（Star 最不打扰，摆在最后）。
 *
 * 原先是贴页面左下角的悬浮胶囊（`fixed start-5 bottom-4`）；2026-11-17 用户要求挪进
 * 控制台顶栏、挨着左侧那组设备信息，于是改成**横排的一组**：去掉 `fixed` 与悬浮阴影，
 * 由调用方把它放进顶栏的 flex 行里。`compact` 仍决定按钮尺寸（sm / lg）。
 */
import { JoinGroupButton } from './JoinGroupButton.tsx'
import { SponsorButton } from './SponsorButton.tsx'
import { StarButton } from './StarButton.tsx'

type Props = {
  /** 小一号（控制台那一窗）。 */
  compact?: boolean
}

export function FloatingActions({ compact = false }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StarButton compact={compact} />
      <SponsorButton compact={compact} />
      <JoinGroupButton compact={compact} />
    </div>
  )
}
