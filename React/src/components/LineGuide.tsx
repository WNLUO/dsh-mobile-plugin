// 线路页顶部的「跟着做」步骤条：新用户第一次进来不知道该先点哪儿。
import { t } from '../lib/i18n/index.ts'

export type GuideStep = { title: string; body: string }

/**
 * 一条线路的使用步骤。
 *
 * 为什么放在页面最上面：这两条线路各自都有一段「先做什么、再去哪儿」的过程（一条要在浏览器
 * 里登录，另一条还要去对方控制台建服务），卡片上的按钮只说「连接」「安装」，第一次用的人
 * 不知道顺序。步骤条只讲顺序，不重复按钮上的字。
 *
 * `activeIndex` 给了就把做过的步骤打勾、当前那步高亮：ZeroNews 那边能从宿主的连接阶段读出来，
 * 让用户知道自己走到哪了；节点小宝的状态在下面那张卡里，这里就不猜。
 */
export function LineGuide({ steps, activeIndex }: { steps: GuideStep[]; activeIndex?: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-muted bg-background-muted p-3">
      <span className="text-xs font-medium text-foreground-strong">{t('panel.guide.title')}</span>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => {
          const done = typeof activeIndex === 'number' && index < activeIndex
          const active = typeof activeIndex === 'number' && index === activeIndex
          return (
            <li key={step.title} className="flex gap-2">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums ${
                  done
                    ? 'border-success text-success'
                    : active
                      ? 'border-primary text-primary'
                      : 'border-border-muted text-foreground-muted'
                }`}
              >
                {done ? '✓' : index + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-xs text-foreground-strong">{step.title}</span>
                <span className="text-xs leading-5 text-foreground-muted">{step.body}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
