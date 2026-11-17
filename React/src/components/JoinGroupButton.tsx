/**
 * 「加入交流群」按钮（微信图标），点开弹群二维码。
 *
 * 与「给个 Star」「赞助」同一排：2026-11-17 从页面悬浮挪进控制台顶栏左侧，三颗横排，
 * 由 `FloatingActions` 统一编排，这里只管自己这颗按钮与那扇窗。
 *
 * 图标用 Simple Icons 的官方 WeChat 标（CC0，`simple-icons/icons/wechat.svg`）：
 * 单条 `path` 的实心标，24×24。之前手画的那版一对气泡不像，换掉。实心标靠
 * `fill` 上色，所以这里不能像描边图标那样写 `fill="none"`；按钮的
 * `[&_svg:not([class*='stroke-'])]:stroke-[1.85]` 会给它描一道 1.85 的边，
 * 所以显式带上 `stroke-` 类把这条规则挡掉（实心标不要描边）。
 *
 * 二维码图与官网「微信交流群」用的是同一张（`website/src/assets/wechat-group.png`，
 * 两边各存一份）：官网那边是独立站点、打不进插件产物，插件产物又是单文件内联，
 * 引不到仓外。换群时两个地方都要换。
 */

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Button } from '@appica/ui-react/button'
import { useState } from 'react'

import wechatGroup from '../assets/wechat-group.png'
import { t } from '../lib/i18n/index.ts'
import { usePanelLanguage } from '../lib/i18n/use-language.ts'

/** 二维码是张方图，窗宽按它给：再宽就只剩白边了。 */
const QR_ALT = () => t('panel.links.wechatQrAlt')

function WechatIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="stroke-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  )
}

/**
 * `compact`：小一号的胶囊（控制台那一窗用）。
 *
 * 那一窗比网页版窄，三颗 `size="lg"` 的胶囊并排在顶栏会挤到设备名，所以降成 `sm`。
 * 与网页版那套是**同一份组件、同一个弹窗**，只是尺寸不同。
 */
export function JoinGroupButton({ compact = false }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  // 微信群只服务中文用户：群公告、交流都用中文，其他语言的人进来看不懂、也问不到答案。
  // 2026-11-17 用户要求非简中 / 繁中时不显示这颗按钮。切语言时随外壳重绘即时生效。
  const language = usePanelLanguage()
  if (language !== 'zh-Hans' && language !== 'zh-Hant') return null

  return (
    <>
      {/* 三颗的横排编排归 `FloatingActions`；这里只管自己那颗按钮。 */}
      <Button
        variant="primary"
        size={compact ? 'sm' : 'lg'}
        className="pointer-events-auto rounded-full shadow-lg"
        onClick={() => setOpen(true)}
      >
        <WechatIcon />
        {t('panel.links.joinGroup')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="sr-only">{t('panel.links.joinGroup')}</DialogTitle>
          <DialogBody className="flex justify-center">
            <img src={wechatGroup} alt={QR_ALT()} className="w-full rounded-md" />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
