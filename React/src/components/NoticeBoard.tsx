/**
 * 公用中转的版本门槛公告：一个按钮 + 一个弹窗（2026-11-13 从常驻卡片改成这样）。
 *
 * 为什么改：「最低插件版本 ≥ 0.4.9」「苹果商店版正式发布后生效」这两条是**长期不变**的
 * 事实，绝大多数时候跟用户此刻要做的事无关，却占掉一整张卡的高度。做成按钮挂在一处，
 * 想知道的人点开看，不想知道的人不用为它让版面 —— 这与「结果走胶囊、持续状态才留在卡片里」
 * 同一条判断（见 `lib/notify.ts` 文件头），只不过这一次它是「持续但低频」。
 *
 * `MIN_PLUGIN_VERSION` 是版本公告**唯一**可变的部分：十门语言的正文都从它取 `{version}`，
 * 它与中转那条真正拦人的配置（同名环境变量）、App 里「插件版本过旧」的提醒同一口径，
 * 改值要三处一起。
 */
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useState } from 'react'

import { t } from '../lib/i18n/index.ts'
import { Dot } from './InfoRow.tsx'
import { SetupGuideDialog } from './SetupGuideDialog.tsx'

/** 公用中转要求的最低插件版本。改它 = 改整条公告。 */
const MIN_PLUGIN_VERSION = '0.4.9'

export function NoticeBoard({ lanPort }: { lanPort: number }) {
  // 公告本体与「搭建教程」是两层窗：前者一句话说完，后者是那份方案清单。
  const [open, setOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" className="w-full justify-between" onClick={() => setOpen(true)}>
        <span>{t('panel.notice.title')}</span>
        <span className="text-xs text-foreground-muted">{`${t('panel.notice.versionLabel')} ≥ ${MIN_PLUGIN_VERSION}`}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('panel.notice.title')}</DialogTitle>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-3">
            <section className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="text-sm text-foreground-muted">{t('panel.notice.versionLabel')}</span>
                <Badge variant="warning" size="sm">
                  {`≥ ${MIN_PLUGIN_VERSION}`}
                </Badge>
              </div>

              {/* 生效条件：那枚点装在跟行高一样高的格子里居中摆，才会真的压在**这一行的字**上。 */}
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
                  onClick={() => {
                    setOpen(false)
                    setGuideOpen(true)
                  }}
                >
                  {t('panel.notice.selfHostAction')}
                </button>
              </div>
              <p className="text-sm leading-6 text-foreground-muted">{t('panel.notice.selfHostBody')}</p>
            </section>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <SetupGuideDialog open={guideOpen} onOpenChange={setGuideOpen} port={lanPort} />
    </>
  )
}
