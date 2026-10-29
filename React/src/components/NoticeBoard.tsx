/**
 * 右栏最上面那块公告：公用中转要求的插件最低版本。
 *
 * ## 为什么是右栏的一张卡，而不是浮在页面外面
 *
 * 它最早浮在内容列左边那条缝里（`position: fixed` + `1500px` 断点），只有特别宽的窗口才看得见。
 * 2026-10-30 用户要求挪到「连接状态」上面、做成同一列里的固定卡：这一列本来就是「这台电脑
 * 现在怎么样」，版本门槛和它说的是同一件事，并排放着比在屏幕边上飘着更容易被读到；顺带
 * 窄屏也不用再整块隐藏 —— 两列并一列时这一列排在最前，手机上滚下来第一张就是它。
 *
 * 引导页不再有这块公告（同一天用户的决定）：这类公告是「进了插件页才需要看」的东西，
 * 配对那一步只需要看得懂二维码。
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
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'

import { t } from '../lib/i18n/index.ts'
import { Dot, InfoList, InfoRow } from './InfoRow.tsx'

/** 公用中转要求的最低插件版本。改它 = 改整条公告。 */
const MIN_PLUGIN_VERSION = '0.4.9'

export function NoticeBoard() {
  return (
    <Card frame="solid">
      <CardHeader>
        <CardTitle>{t('panel.notice.title')}</CardTitle>
      </CardHeader>

      <InfoList>
        <InfoRow label={t('panel.notice.versionLabel')}>
          <Badge variant="warning" size="sm">
            {`≥ ${MIN_PLUGIN_VERSION}`}
          </Badge>
        </InfoRow>
      </InfoList>

      <p className="mt-3 flex items-start gap-1.5 text-sm text-foreground-muted">
        <span className="mt-2">
          <Dot tone="warn" />
        </span>
        <span className="min-w-0">{t('panel.notice.effective')}</span>
      </p>

      <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
        {t('panel.notice.body', { version: MIN_PLUGIN_VERSION })}
      </p>
    </Card>
  )
}
