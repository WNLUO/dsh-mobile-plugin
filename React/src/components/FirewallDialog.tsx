/**
 * 「检查网络 / 检查防火墙」弹窗：手机连不上这台电脑的直连端口时，按系统各给一段能直接
 * 照抄的排查命令。
 *
 * 它原本只挂在引导页里（那一步正是「手机还没连上」），2026-11-02 起配对卡右上角也开同一个弹窗：
 * 配对卡也是「连不上时看哪儿」的地方，两边讲的是同一件事，所以只写这一份。
 *
 * 页面自己**不去跑**这些命令：本机运维界面没有、也不该有执行 shell 的能力面（见移动 API 的
 * 能力面约定）。三栏底部那颗按钮把同一段「给 AI 的委托信」复制到剪贴板，剩下的交给用户。
 */
import { Button } from '@appica/ui-react/button'
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

/** 三栏排查步骤。命令照抄就能用；`cmd` 为真时按等宽字体摆。 */
const FIREWALL_LINUX: { text?: string; textKey?: string; cmd?: boolean }[] = [
  { textKey: 'panel.onboarding.linuxStep1' },
  { text: 'systemctl status firewalld', cmd: true },
  { text: 'sudo ufw status', cmd: true },
  { textKey: 'panel.onboarding.linuxStep2' },
  { text: 'sudo firewall-cmd --permanent --add-port={port}/tcp\nsudo firewall-cmd --reload', cmd: true },
  { text: 'sudo ufw allow {port}/tcp', cmd: true },
  { textKey: 'panel.onboarding.linuxStep3' },
]

const FIREWALL_MAC: { text?: string; textKey?: string; cmd?: boolean }[] = [
  { textKey: 'panel.onboarding.macStep1' },
  { text: '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate', cmd: true },
  { textKey: 'panel.onboarding.macStep2' },
  { text: 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off', cmd: true },
  { textKey: 'panel.onboarding.macStep3' },
]

const FIREWALL_WINDOWS: { text?: string; textKey?: string; cmd?: boolean }[] = [
  { textKey: 'panel.onboarding.winStep1' },
  { text: 'Get-NetFirewallProfile | Select-Object Name, Enabled', cmd: true },
  { textKey: 'panel.onboarding.winStep2' },
  { text: 'New-NetFirewallRule -DisplayName "DSH Mobile {port}" -Direction Inbound -LocalPort {port} -Protocol TCP -Action Allow', cmd: true },
  { textKey: 'panel.onboarding.winStep3' },
]

/**
 * 「点我复制」复制出去的那段话。**三栏复制的是同一份**：它不是哪一栏的内容，
 * 而是一封给 AI 的委托信 —— 先说清在做什么、卡在哪、要 AI 回答什么问题。
 *
 * 这里**不写具体地址和端口**：地址每台机器都不同、端口被占时还会自动换，写死在文案里
 * 比不写更容易误导；改成让 AI 去面板上看，并强调「是局域网地址」。
 */
function aiCheckPrompt(): string {
  // 每一门语言都是一段**能直接粘给 AI 的完整提示词**，不是逐字直译的碎句。
  return [
    t('panel.onboarding.prompt.intro'),
    '',
    t('panel.onboarding.prompt.situation'),
    t('panel.onboarding.prompt.address'),
    t('panel.onboarding.prompt.guess'),
    '',
    t('panel.onboarding.prompt.ask'),
    t('panel.onboarding.prompt.ask1'),
    t('panel.onboarding.prompt.ask2'),
    t('panel.onboarding.prompt.ask3'),
    t('panel.onboarding.prompt.ask4'),
    '',
    t('panel.onboarding.prompt.extra'),
  ].join('\n')
}

/**
 * 弹窗里的一栏：标题居中 + 若干条步骤（命令按等宽块摆）+ 底部一颗「复制给 AI」的按钮。
 *
 * 三栏的按钮复制的是**同一份** `aiCheckPrompt()`：它是一封给 AI 的委托信，不是这一栏的
 * 内容（见那个函数的注释）。这三个按钮是「同一件事的三个入口」，谁按都一样。
 */
function FirewallPane({
  title,
  steps,
  port,
  onCopied,
}: {
  title: string
  steps: { text?: string; textKey?: string; cmd?: boolean }[]
  port: string
  onCopied: (ok: boolean) => void
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(aiCheckPrompt())
      onCopied(true)
    } catch {
      onCopied(false)
    }
  }

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-border-muted bg-background-muted p-3">
      <h3 className="text-center text-sm font-semibold text-foreground-intense">{title}</h3>
      {steps.map((step) => {
        // 命令是原样的（不翻译），说明文字走字典键。
        const body = (step.text ?? (step.textKey ? t(step.textKey) : '')).replace(/\{port\}/g, port)
        return step.cmd ? (
          <pre
            key={body}
            className="rounded bg-background-subtle px-2 py-1.5 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-foreground-strong"
          >
            {body}
          </pre>
        ) : (
          <p key={body} className="text-xs leading-5 text-foreground-muted">
            {body}
          </p>
        )
      })}
      {/* 底部对齐：三栏步骤长短不一，按钮仍落在同一水平线上。 */}
      <Button className="mt-auto" variant="outline" size="sm" onClick={() => void copy()}>
        {t('panel.onboarding.copyPromptHint')}
      </Button>
    </section>
  )
}

/**
 * @param port 直连端口（宿主 `lan.port`）：命令里的方括号按它填，别让用户自己替换。
 */
export function FirewallDialog({
  open,
  onOpenChange,
  port,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  port: string
}) {
  const [copied, setCopied] = useState<'' | 'ok' | 'failed'>('')
  const onCopied = (ok: boolean) => setCopied(ok ? 'ok' : 'failed')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 关了就把上一次的复制结果清掉：下次开窗不该先挂着上一轮的「已复制」。
        if (!next) setCopied('')
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-[min(1200px,92vw)] max-w-none" backdropProps={{ className: 'z-[80]' }} viewportProps={{ className: 'z-[80]' }}>
        <DialogHeader>
          <DialogTitle>{t('panel.onboarding.firewallTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm text-foreground-muted">
            {t('panel.onboarding.firewallIntro')}{' '}
            <span className="font-mono">{port}</span>
            {t('panel.onboarding.firewallIntroTail')}
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <FirewallPane title="Linux" steps={FIREWALL_LINUX} port={port} onCopied={onCopied} />
            <FirewallPane title="Mac" steps={FIREWALL_MAC} port={port} onCopied={onCopied} />
            <FirewallPane title="Windows" steps={FIREWALL_WINDOWS} port={port} onCopied={onCopied} />
          </div>
        </DialogBody>
        {copied ? (
          <DialogFooter className="flex justify-end">
            <span className="text-xs text-foreground-muted">
              {copied === 'ok' ? t('panel.onboarding.copiedOk') : t('panel.onboarding.copiedFailed')}
            </span>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
