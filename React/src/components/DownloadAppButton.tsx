/**
 * 「下载 APP」按钮 + 它点开的渠道弹窗。
 *
 * 按钮原来是一条直链，跳到官网首页再让人自己挑；现在点开就在面板里挑。弹窗改成两列：
 * 左边安卓、右边苹果，每列两条渠道。分组理由是**平台不能选错**：安卓的包装不进 iPhone，
 * 反过来也一样，所以先报平台、再报渠道。组内顺序也不是随意的：分发平台那条与商店那条是
 * 绝大多数人要的，GitHub 与 TestFlight 是「想拿更早 / 更新的构建」才会走。
 *
 * 图标一律手写内联 SVG（Simple Icons 的 CC0 路径，Android / Apple / GitHub 三家）：
 * 插件产物是单文件内联，引不到仓外资源，也不值得为一个标多带一个图标库。App 自己的
 * logo 是 `assets/ai-hub-logo.png`（从官网那份 1254px 缩到 128px，`inline.mjs` 会把它
 * 连同图片一起塞进单文件）。
 *
 * 链接与分组都在 `lib/links.ts` 的 `DOWNLOAD_CHANNELS`：引导页与配对卡两处渲染的是
 * 同一个组件，各写一份必然只改掉其中一处。
 */
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useRef, useState } from 'react'

import appLogo from '../assets/ai-hub-logo.png'
import { DOWNLOAD_CHANNELS, type DownloadChannel } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  /** 对齐旁边那排按钮的尺寸；引导页底部那一排是默认的 md。 */
  size?: 'md' | 'lg'
}

/** 图标按着渠道的 `name` 取：渠道表里只放链接与文案，图形留在这里。 */
function channelGlyph(channel: DownloadChannel) {
  if (channel.name === 'GitHub') return <GithubMark />
  if (channel.name === 'App Store') return <AppleMark />
  if (channel.name === 'TestFlight') return <TestFlightMark />
  return <DownloadMark />
}

function platformGlyph(platform: string) {
  return platform === 'android' ? <AndroidMark /> : <AppleMark />
}

/** 渠道卡：图标在左，名字与那句说明在右；整张卡是一个外链，点哪都能开。 */
function ChannelCard({ channel }: { channel: DownloadChannel }) {
  return (
    <a
      className="flex items-center gap-3 rounded-lg border border-border-muted px-3 py-2.5 transition-colors hover:bg-background-muted"
      href={channel.url}
      target="_blank"
      rel="noreferrer noopener"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-muted text-foreground">
        {channelGlyph(channel)}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground-intense">{channel.name ?? (channel.nameKey ? t(channel.nameKey) : '')}</span>
        <span className="text-xs text-foreground-muted">{t(channel.hintKey)}</span>
      </span>
    </a>
  )
}

export function DownloadAppButton({ size = 'md' }: Props) {
  const [open, setOpen] = useState(false)
  /** 落焦目标：弹窗容器自己，不是第一张渠道卡 —— 一打开就给第一张描上焦点环，像是已经选中了。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)

  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        下载 APP
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl" closeLabel={t('panel.common.close')} initialFocus={dialogRef}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <img src={appLogo} alt="" className="size-8 rounded-lg bg-white p-0.5" />
              下载 AI-HUB
            </DialogTitle>
          </DialogHeader>

          {/* 两列按平台分，窄屏（面板被夹在侧栏里时）自己叠成一列。 */}
          <div ref={dialogRef} tabIndex={-1} className="outline-none">
          <DialogBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {DOWNLOAD_CHANNELS.map((group) => (
              <div key={group.platform} className="flex flex-col gap-2">
                <div className="flex items-center justify-center gap-1.5 pb-0.5 text-xs text-foreground-muted">
                  {platformGlyph(group.platform)}
                  <span>{t(group.platform === 'android' ? 'panel.links.android' : 'panel.links.apple')}</span>
                </div>
                {group.channels.map((channel) => (
                  <ChannelCard key={channel.url} channel={channel} />
                ))}
              </div>
            ))}
          </DialogBody>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Simple Icons 的 `android`（CC0）。实心标，靠 `fill` 上色，别加描边。 */
function AndroidMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 stroke-0" fill="currentColor" aria-hidden="true">
      <path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-.9997s.4483-.9993.9993-.9993c.5511 0 .9993.4483.9993.9993.0001.5511-.4482.9997-.9993.9997m-11.046 0c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.551 0 .9993.4483.9993.9993 0 .5511-.4483.9997-.9993.9997m11.4045-6.02 1.9973-3.4592a.416.416 0 0 0-.1521-.5676.416.416 0 0 0-.5676.1521l-2.0223 3.503C15.5902 8.2439 13.8533 7.8508 12 7.8508s-3.5902.3931-5.1367 1.0989L4.841 5.4467a.4161.4161 0 0 0-.5677-.1521.4157.4157 0 0 0-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3435-4.1021-2.6892-7.5743-6.1185-9.4396" />
    </svg>
  )
}

/** Simple Icons 的 `apple`（CC0）。 */
function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 stroke-0" fill="currentColor" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  )
}

/** Simple Icons 的 `github`（CC0）。 */
function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px] stroke-0" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

/** 分发平台那条不是某个品牌，用一颗「安装包 / 下载」的描边图标，跟着主题色走。 */
function DownloadMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v10" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M4 18.5h16" />
    </svg>
  )
}

/**
 * TestFlight 没有官方单色标可抄，用一颗纸飞机（与官网同一个 path，24×24 描边风格）。
 * 它是唯一一颗**描边**图标，所以不做 `stroke-0`：按钮基类那条 1.85 的描边在这里正好。
 */
function TestFlightMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 3 3 10.5l7.5 3L14 21l7-18Z" />
      <path d="M21 3 10.5 13.5" />
    </svg>
  )
}
