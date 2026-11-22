/**
 * 苹果测试版公告：进来就弹一次，不需要任何入口按钮（用户 2026-11-22 要求）。
 *
 * 说的是「测试版比 App Store 正式版领先好几个版本，建议先用测试版」，底部一颗去
 * TestFlight 的按钮。链接取 `lib/links.ts` 的 `TESTFLIGHT_URL` —— 与「下载 APP」弹窗
 * 里 TestFlight 那条同源，改地址只改一处。
 *
 * 挂在外壳（`Shell.tsx`）里而不是控制台内部：引导页与主页都该看到它。开合沿用弹窗自己的
 * 规矩，右上角那颗 × 与点遮罩都能关；关掉只在本次会话记住，刷新会再弹一次 —— 与
 * `PublicRelayNoticeDialog` 同一种口径。要「关一次就永久不再弹」再说，先不做落盘。
 */
import { Button, buttonVariants } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useState } from 'react'

import { t } from '../lib/i18n/index.ts'
import { TESTFLIGHT_URL } from '../lib/links.ts'

export function AnnouncementDialog() {
  // 本次会话里关过就不再弹；刷新重来（与公用中转提示同一口径）。
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setDismissed(true) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.announcement.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="whitespace-pre-line text-sm leading-6 text-foreground-muted">
          {t('panel.announcement.body')}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDismissed(true)}>
            {t('panel.announcement.dismiss')}
          </Button>
          {/* 外链用 <a> 而不是 window.open：桌面壳只把 http(s) 交给系统浏览器。 */}
          <a
            href={TESTFLIGHT_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            {t('panel.announcement.betaAction')}
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
