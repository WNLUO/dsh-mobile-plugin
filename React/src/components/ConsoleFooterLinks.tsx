/**
 * 控制台页脚那一排小入口：交流群 / 赞助 / 给个 Star / 重看引导。
 *
 * 网页版把群、赞助、star 三颗做成右下角的悬浮胶囊（各自挂一处 `fixed`）。控制台那一窗
 * 不用悬浮：它本身就矮，三颗胶囊会压在设备列表与底部出口上，窄窗里尤其明显。所以这里换成
 * 页脚一行**文字链**，点开的还是原来那几个弹窗（群二维码、USDT 地址、GitHub 仓库页），
 * 弹窗内容一个字节都没重写。
 *
 * 「重看引导」只在**已经配过**的时候才有意义（没配过本来就在引导里），所以由调用方按状态
 * 决定要不要传 `onReplayGuide`。
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useState } from 'react'

import wechatGroup from '../assets/wechat-group.png'
import { PLUGIN_REPO_URL } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'
import { SponsorLink } from './SponsorButton.tsx'

/** 群二维码是张方图，窗宽按它给。 */
const GROUP_QR_ALT = () => t('panel.links.wechatQrAlt')

export function ConsoleFooterLinks({ onReplayGuide }: { onReplayGuide?: () => void }) {
  const [groupOpen, setGroupOpen] = useState(false)

  return (
    <>
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-muted">
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground-strong"
          onClick={() => setGroupOpen(true)}
        >
          {t('panel.links.joinGroup')}
        </button>
        <SponsorLink />
        <a
          href={PLUGIN_REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2 hover:text-foreground-strong"
        >
          {t('panel.links.star')}
        </a>
        {onReplayGuide ? (
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-foreground-strong"
            onClick={onReplayGuide}
          >
            {t('panel.console.replayGuide')}
          </button>
        ) : null}
      </nav>

      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="sr-only">{t('panel.links.joinGroup')}</DialogTitle>
          <DialogBody className="flex justify-center">
            <img src={wechatGroup} alt={GROUP_QR_ALT()} className="w-full rounded-md" />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
