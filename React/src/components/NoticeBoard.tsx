/**
 * 左栏那块一直浮在页面上的公告板：公用中转要求的插件最低版本。
 *
 * ## 为什么是「悬浮」而不是一张卡
 *
 * 这条公告说的是「版本低了就连不上」，而要被提醒的人恰恰**不会主动去翻面板** ——
 * 所以它不挂在任何一张卡里、也不跟着正文滚走：固定在左栏那块空地上，滚到哪儿都看得见。
 *
 * 落位与宽度都按容器算：右边缘始终贴着 `max-w-6xl` 那口子的左边（`50% + 36rem + 1rem`），
 * 宽度吃掉这条缝剩下的部分（`clamp(9rem, …, 18rem)`）—— 缝有多宽它有多宽，宽屏上到 18rem
 * 封顶，不会被甩到屏幕角落，也不会在窄屏上把字挤成一根细条。窄到缝里放不下 9rem 就整块
 * 不出现（`min-[1500px]`）：硬摆会压住左边的卡片，而这里只是「顺带让路过的人看见」，
 * 不值得为它去挤正文。
 *
 * ## 为什么标题不是 `CardHeader` + `CardTitle`
 *
 * 那两个的档位是给 500px 宽的大卡定的：`p-6` 的头 + `text-lg` 的标题，落到这条缝里
 * 只剩百来像素的正文宽，标题要折三行、还断得难看。而 `className` 压不住它们
 * （同属性谁在样式表里靠后谁赢，`p-4` 赢不了 `p-6`、`text-sm` 赢不了 `text-lg`），
 * 所以这里用一个 `p-3` 的容器 + 一枚同款 token 的 `h3`，卡片外壳仍然走库里的 `Card`。
 *
 * ## 号从哪来
 *
 * `MIN_PLUGIN_VERSION` 是这条公告**唯一**可变的部分，十门语言的正文都从它取
 * `{version}`。改号只改这一行；改完按面板的规矩重建产物
 * （`cd React && pnpm run build` → `lib/panel/index.html` 是提交物）。
 * 与中转那条真正会拦人的配置（`MIN_PLUGIN_VERSION` 环境变量，见 A4-25）、App 里那条
 * 「插件版本过旧」的提醒，是同一个口径：这里只负责说，拦是它们的事，改值要三处一起。
 *
 * App 那一侧暂时没有条目：商店版还没正式发出去，此刻给不出确切的号，先空着。
 */
import { Badge } from '@appica/ui-react/badge'
import { Card } from '@appica/ui-react/card'

import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'

/** 公用中转要求的最低插件版本。改它 = 改整条公告。 */
const MIN_PLUGIN_VERSION = '0.4.9'

export function NoticeBoard() {
  return (
    <aside
      className="fixed top-6 z-30 hidden min-[1500px]:block"
      style={{
        // 右边缘钉在内容列左边再往左 1rem；宽度吃掉剩下的缝，两头各留 1rem。
        insetInlineStart: 'auto',
        insetInlineEnd: 'calc(50% + 36rem + 1rem)',
        width: 'clamp(9rem, calc(50% - 38rem), 18rem)',
      }}
    >
      <Card frame="solid" className="shadow-lg">
        <div className="p-3">
          <h3 className="text-sm leading-snug font-semibold text-foreground-intense">{t('panel.notice.title')}</h3>

          {/* 标签与号分两行是**故意的**：一行放不下的宽度区间太大（缝 152px 时
              中文标签加徽标要 154px，差两像素就折行，看着像坏掉），索性一律两行。 */}
          <div className="mt-2 border-b border-border-muted pb-2">
            <div className="text-xs text-foreground-muted">{t('panel.notice.versionLabel')}</div>
            <div className="mt-1">
              <Badge variant="warning" size="sm">
                {`≥ ${MIN_PLUGIN_VERSION}`}
              </Badge>
            </div>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-xs text-foreground-muted">
            <span className="mt-1">
              <Dot tone="warn" />
            </span>
            <span className="min-w-0">{t('panel.notice.effective')}</span>
          </p>

          <p className="mt-1.5 text-xs leading-relaxed text-foreground-muted">
            {t('panel.notice.body', { version: MIN_PLUGIN_VERSION })}
          </p>
        </div>
      </Card>
    </aside>
  )
}
