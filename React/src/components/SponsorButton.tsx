/**
 * 页面右下角那颗「赞助」的悬浮按钮，点开弹 USDT 收款二维码。
 *
 * 与「加入交流群」并排：那颗落在 `bottom-6`，这颗排在它上面（`bottom-24`）。
 * 同样是「跟这台机器现在怎么样了无关、但想让人一直看得见」的东西，所以挂在页面
 * 边缘而不是某张卡片里。
 *
 * 收款地址是 Polygon 上的 USDT：`0x` 开头是 EVM 地址，收不了 TRC20 那种 `T` 开头的。
 * 二维码里编的是**纯地址**，不带 EIP-681 的链前缀 —— 带链的写法只有部分钱包认，认不出
 * 的扫了等于没反应；纯地址任何钱包都填得进去，网络这一层靠窗里的文案写死。
 * 二维码是构建时预生成的静态图（`assets/sponsor-usdt-qr.png`），由 vite 内联进单文件
 * 产物，运行时没有任何二维码依赖。
 *
 * 地址一旦公开就收不回（链上余额与流水全部可查），所以这里只做「展示 / 复制」，
 * 不做任何「一键跳转钱包」的链接 —— 那类链接中途被替换成别的地址，钱就追不回来了。
 *
 * 版面按「一眼看完三步」排，而不是把每样东西都摊开：标题与一句说明在表头，中间是二维码
 * 与两枚币种 / 网络标签，下面一行地址自带复制钮（复制就地给回执，不再另起一颗大按钮），
 * 最底下一句「感谢！」垫住（2026-11-10 用户要求：提醒语整条删掉，收尾不说免责只说谢谢）。
 */

import { Button } from '@appica/ui-react/button'
import { Chip } from '@appica/ui-react/chip'
import { CopyButton } from '@appica/ui-react/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useState } from 'react'

import sponsorQr from '../assets/sponsor-usdt-qr.png'
import { t } from '../lib/i18n/index.ts'

/** 收款地址：全小写、不带任何链前缀。改地址时连同二维码一起换（那张图是按这个串生成的）。 */
const SPONSOR_ADDRESS = '0x62744c084c272ddba4680920edc3239cb7180718'

function HeartIcon() {
  // Material Icons 的心形（Apache 2.0，单条实心 path）。按钮基类会给没带 `stroke-`
  // 的 svg 描 1.85 的边，实心标不需要，所以显式带 `stroke-0` 挡掉。
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className="stroke-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  )
}

export function SponsorButton() {
  const [open, setOpen] = useState(false)
  // 复制失败是唯一要留下的话：成功由复制钮自己换成「已复制」，失败得说清为什么。
  const [copyFailed, setCopyFailed] = useState(false)

  return (
    <>
      <div className="pointer-events-none fixed end-6 bottom-24 z-40">
        <Button
          variant="secondary"
          size="lg"
          className="pointer-events-auto rounded-full shadow-lg"
          onClick={() => {
            setCopyFailed(false)
            setOpen(true)
          }}
        >
          <HeartIcon />
          {t('panel.links.sponsor')}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-xl">{t('panel.links.sponsorTitle')}</DialogTitle>
            <DialogDescription>{t('panel.links.sponsorIntro')}</DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            {/* 二维码：收到 180 以内，留白给下面的地址与提醒；底色必须是白的，深色主题下
                半透明白底会让码的对比度掉下来。 */}
            <div className="flex justify-center">
              <img
                src={sponsorQr}
                alt={t('panel.links.sponsorQrAlt')}
                className="size-44 rounded-lg border border-border-muted bg-white p-2"
              />
            </div>

            {/* 币种与网络两枚标签：比一整块「网络：Polygon」省一半高度，读起来也更快。 */}
            <div className="flex justify-center gap-2">
              <Chip variant="soft" size="sm">
                USDT
              </Chip>
              <Chip variant="soft" size="sm">
                Polygon
              </Chip>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border-muted bg-background-muted p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-foreground-muted">
                  {t('panel.links.sponsorAddress')}
                </span>
                <CopyButton
                  value={SPONSOR_ADDRESS}
                  label={t('panel.links.sponsorCopy')}
                  copiedLabel={t('panel.links.sponsorCopied')}
                  size="sm"
                  variant="outline"
                  onCopyError={() => setCopyFailed(true)}
                  onCopy={() => setCopyFailed(false)}
                >
                  {t('panel.links.sponsorCopy')}
                </CopyButton>
              </div>
              <code className="block select-all break-all font-mono text-[11px] leading-4 text-foreground-strong">
                {SPONSOR_ADDRESS}
              </code>
              {copyFailed ? (
                <p className="text-[11px] leading-4 text-foreground-strong">
                  {t('panel.links.sponsorCopyFailed')}
                </p>
              ) : null}
            </div>
          </DialogBody>

          {/* 收尾那句单独垫在最底下，不与地址框挤在一起。 */}
          <div className="px-6 pt-4 pb-6">
            <p className="text-center text-sm text-foreground-muted">
              {t('panel.links.sponsorNote')}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
