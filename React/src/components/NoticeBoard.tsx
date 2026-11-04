/**
 * 右栏最上面那块公告卡：一条是公用中转的插件版本门槛，一条是「想自己搭就自己搭」。它排在
 * 「连接状态」上面同一列里 —— 这一列说的是「这台电脑现在怎么样」，版本门槛也是这件事。
 *
 * `MIN_PLUGIN_VERSION` 是版本公告**唯一**可变的部分，十门语言正文都从它取 `{version}`；它与中转
 * 那条真正拦人的配置（同名环境变量）、App 里「插件版本过旧」的提醒同一口径，改值要三处一起。
 */
import { Badge } from '@appica/ui-react/badge'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'

import { useState } from 'react'

import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'
import { SetupGuideDialog } from './SetupGuideDialog.tsx'

/** 公用中转要求的最低插件版本。改它 = 改整条公告。 */
const MIN_PLUGIN_VERSION = '0.4.9'

export function NoticeBoard({ lanPort }: { lanPort: number }) {
  // 「搭建教程」开的是方案弹窗（自建中转 / 内网穿透 / 局域网直连），仓库链接在弹窗里。
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <Card frame="solid">
      {/* 标题下面那段空白由 header 的 p-6 撑着；这一卡内容本来就短，用行内值把底部收回来，
          `className` 压不动同属性的 p-6（同属性谁在样式表里靠后谁赢）。 */}
      <CardHeader style={{ paddingBottom: '0.5rem' }}>
        <CardTitle>{t('panel.notice.title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <section className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-sm text-foreground-muted">{t('panel.notice.versionLabel')}</span>
            <Badge variant="warning" size="sm">
              {`≥ ${MIN_PLUGIN_VERSION}`}
            </Badge>
          </div>

          {/* 生效条件：那枚点装在跟行高一样高的格子里居中摆，才会真的压在**这一行的字**上。
              别改回给点加 `mt-*` —— 行内元素自带行盒，估出来的偏移总差几像素。 */}
          <p className="flex items-start gap-2 text-sm leading-5 text-foreground-muted">
            <span className="flex h-5 shrink-0 items-center">
              <Dot tone="warn" />
            </span>
            <span className="min-w-0">{t('panel.notice.effective')}</span>
          </p>

          <p className="text-sm leading-6 text-foreground-muted">
            {t('panel.notice.body', { version: MIN_PLUGIN_VERSION })}
          </p>
        </section>

        {/* 一条建议，不是动作：教程链接挂在标题那一行右侧，与上面那条公告的「≥ 版本」同一种排法。 */}
        <section className="flex flex-col gap-1.5 border-t border-border-muted pt-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-medium text-foreground-strong">{t('panel.notice.selfHostTitle')}</h3>
            <button
              type="button"
              className="cursor-pointer text-sm text-foreground-intense underline underline-offset-2 hover:text-foreground-strong"
              onClick={() => setGuideOpen(true)}
            >
              {t('panel.notice.selfHostAction')}
            </button>
          </div>
          <p className="text-sm leading-6 text-foreground-muted">{t('panel.notice.selfHostBody')}</p>
        </section>
      </div>

      <SetupGuideDialog open={guideOpen} onOpenChange={setGuideOpen} port={lanPort} />
    </Card>
  )
}
