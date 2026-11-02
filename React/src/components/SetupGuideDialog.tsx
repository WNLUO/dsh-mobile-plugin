/**
 * 「搭建自己的网络」教程：折叠列表，一块一个方案（后面还会加，别做成一段长文）。
 *
 * 两条路线：
 *   · 自建中转 —— 面板里只放一段**委托给用户自己 AI** 的话。装中转要知道他手上有什么
 *     （服务器、系统、域名、nginx、80/443），面板一无所知，写死一套步骤只会对不上；
 *     复制过去让对方的 AI 先问清楚再动手。仓库里已经有编译好的安装包，**不让用户编译**。
 *   · 内网穿透 —— 没有公网 IP 时用，三个系统各自的安装命令都给出来。后面再接一条
 *     Tailscale：本机的直连端口是明文 HTTP，iOS 的 ATS 不认 100.x 的明文地址，
 *     所以让它 serve 成一个 https 的 ts.net 域名，再把那个域名填进直连地址。
 *
 * 版式：所有方案默认收起，展开才占地方；两条都展开时正文比手机屏高，所以在正文区里滚
 * （弹窗卡在视口高度内，遮罩挡住了页面本身的滚动），滚动条不画出来 —— 手机上一根灰条
 * 比「这块能滑」更碍事。别把 `max-h` 写死成 `vh - 某个魔数`：卡片高度由弹窗的 `max-h-full`
 * 约束，再来一个死值在矮屏上会多出一截空白。
 * 关窗沿用弹窗自己的规矩：右上角那颗 × 与点遮罩都能关，底部不摆「我知道了」。
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

import { t } from '../lib/i18n/index.ts'
import { relaySetupPrompt } from '../lib/setupPrompts.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 这台机器直连实际用的端口（面板「局域网端口」那一行）。 */
  port: number
}

/** 一块方案：标题 + 一句摘要，点开才展开正文。 */
function Section({
  title,
  summary,
  children,
}: {
  title: string
  summary: string
  children: React.ReactNode
}) {
  return (
    <details className="group rounded-lg border border-border-muted bg-background-muted">
      <summary className="flex cursor-pointer list-none flex-col gap-0.5 px-3 py-2.5 marker:content-none">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground-strong">
          <svg
            viewBox="0 0 12 12"
            className="size-3 shrink-0 text-foreground-muted transition-transform group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </svg>
          {title}
        </span>
        <span className="pl-5 text-xs leading-5 text-foreground-muted">{summary}</span>
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-border-muted px-3 py-3">{children}</div>
    </details>
  )
}

/** 一段可直接复制的命令。 */
function Cmd({ lines }: { lines: string[] }) {
  return (
    <pre className="overflow-x-auto rounded bg-background-subtle px-2.5 py-2 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-foreground-strong">
      {lines.join('\n')}
    </pre>
  )
}

export function SetupGuideDialog({ open, onOpenChange, port }: Props) {
  /** 落焦到容器而不是第一颗可聚焦的东西：一开窗就圈中「复制」会像已经按过了。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [copied, setCopied] = useState(false)

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(relaySetupPrompt())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCopied(false)
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="w-[min(860px,92vw)] max-w-none"
        closeLabel={t('panel.common.close')}
        initialFocus={dialogRef}
      >
        <DialogHeader>
          <DialogTitle>{t('panel.notice.setupGuideTitle')}</DialogTitle>
        </DialogHeader>
        <div ref={dialogRef} tabIndex={-1} className="flex min-h-0 flex-col outline-none">
          <DialogBody className="flex flex-col gap-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Section title={t('panel.notice.guideRelayTitle')} summary={t('panel.notice.guideRelaySummary')}>
              <p className="text-sm leading-6 text-foreground">{t('panel.notice.guideRelayReady')}</p>
              <p className="text-sm leading-6 text-foreground-muted">{t('panel.notice.guideRelayCopyHint')}</p>
              <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => void copyPrompt()}>
                  {t('panel.notice.guideRelayCopy')}
                </Button>
                {copied ? <span className="text-xs text-success">{t('panel.notice.guideRelayCopied')}</span> : null}
              </div>
              {/* 没有服务器就别为这一步买机器 —— 这条建议必须看得见，不能只写在提示词里。 */}
              <p className="rounded-md border border-border-muted bg-background px-2.5 py-2 text-xs leading-5 text-warning">
                {t('panel.notice.guideRelayWarn')}
              </p>
            </Section>

            <Section title={t('panel.notice.guideTunnelTitle')} summary={t('panel.notice.guideTunnelSummary')}>
              <p className="text-sm leading-6 text-foreground">{t('panel.notice.guideTunnelOS')}</p>
              <Cmd
                lines={[
                  '# macOS',
                  'brew install cloudflared',
                  '# Linux',
                  'curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared',
                  'chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/',
                  '# Windows (PowerShell)',
                  'winget install --id Cloudflare.cloudflared',
                ]}
              />
              <p className="text-sm leading-6 text-foreground">{t('panel.notice.guideTunnelTry')}</p>
              <Cmd lines={[`cloudflared tunnel --url http://127.0.0.1:${port}`]} />
              <p className="text-sm leading-6 text-foreground">{t('panel.notice.guideTunnelFixed')}</p>
              <Cmd
                lines={[
                  'cloudflared tunnel login',
                  'cloudflared tunnel create dsh',
                  'cloudflared tunnel route dns dsh dsh.example.com',
                  `cloudflared tunnel run --url http://127.0.0.1:${port} dsh`,
                ]}
              />
              <p className="text-sm leading-6 text-foreground-muted">{t('panel.notice.guideTunnelFill')}</p>

              <p className="mt-1 border-t border-border-muted pt-3 text-sm font-semibold text-foreground-strong">
                {t('panel.notice.guideTailscaleTitle')}
              </p>
              <p className="text-sm leading-6 text-foreground">{t('panel.notice.guideTailscaleInstall')}</p>
              <Cmd
                lines={[
                  '# macOS',
                  'brew install tailscale',
                  '# Linux',
                  'curl -fsSL https://tailscale.com/install.sh | sh',
                  '# Windows',
                  'winget install --id Tailscale.Tailscale',
                  'sudo tailscale up',
                ]}
              />
              <p className="text-sm leading-6 text-foreground">{t('panel.notice.guideTailscaleServe')}</p>
              <Cmd lines={[`tailscale serve --bg http://127.0.0.1:${port}`]} />
              <p className="text-sm leading-6 text-foreground-muted">{t('panel.notice.guideTailscaleFill')}</p>
            </Section>
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  )
}
