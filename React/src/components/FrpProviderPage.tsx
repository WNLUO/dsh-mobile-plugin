// FRP 服务商页：国内三家正规 frp 运营商共用一个配置导入框，一次只跑一家。
/**
 * 国内 FRP 入口（2026-11-26 用户要求）：樱花 FRP、OpenFrp、乐青 LoCyanFrp 都跑标准 frp，
 * 能力完全一样——到官网注册、拿到配置、贴进来起隧道。所以这里只做一页：上面列三家的
 * 名字、免费档和官网，下面共用一个导入框。
 *
 * 不拆成三行各自判就绪：插件整机只有一份 frpc 配置、一个进程、一个公网地址，接了其中
 * 一家就没有第二家；拆三行会让三家同时显示「已就绪」，那是说谎。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { useEffect, useState } from 'react'

import { frpConfig, importFrp, stopFrp, type StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 导入或停止之后让外层重读宿主状态，引导页那一行的「已就绪」才会跟着变。 */
  onChanged?: () => void
}

const PROVIDERS = [
  { name: 'panel.frpProviders.natfrp', hint: 'panel.frpProviders.natfrpHint', url: 'https://natfrp.com' },
  { name: 'panel.frpProviders.openfrp', hint: 'panel.frpProviders.openfrpHint', url: 'https://openfrp.net' },
  { name: 'panel.frpProviders.locyanfrp', hint: 'panel.frpProviders.locyanfrpHint', url: 'https://locyanfrp.cn' },
] as const

export function FrpProviderPage({ open, onOpenChange, status, onChanged }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  // 开窗时读回当前配置：已经接了一家的，改配置不用从头贴。
  useEffect(() => {
    if (!open) return
    let live = true
    void frpConfig()
      .then((res) => { if (live) setText(res?.config || '') })
      .catch(() => { if (live) setText('') })
    return () => { live = false }
  }, [open])

  if (!open) return null

  async function save() {
    if (!text.trim()) return
    setBusy('save')
    setNote('')
    try {
      const res = await importFrp(text)
      setNote(res.ok ? '' : t('panel.frpProviders.failed', { error: res.status?.error || t('panel.frp.statusStop') }))
      if (res.ok) onChanged?.()
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function stop() {
    setBusy('stop')
    setNote('')
    try {
      await stopFrp()
      onChanged?.()
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const address = status.frp?.running && status.frp?.remoteAddress ? status.frp.remoteAddress : ''

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.region.china')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.frpProviders.title')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.frpProviders.intro')}</p>
          {PROVIDERS.map((provider) => (
            <div key={provider.url} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-muted p-3">
              <span className="text-sm font-medium text-foreground-strong">{t(provider.name)}</span>
              <a href={provider.url} target="_blank" rel="noreferrer" className="text-xs text-accent underline">
                {provider.url.replace(/^https:\/\//, '')}
              </a>
              <p className="w-full text-xs leading-5 text-foreground-muted">{t(provider.hint)}</p>
            </div>
          ))}
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.frpProviders.oneOnly')}</p>
        </div>
      </Card>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm font-medium text-foreground-strong">{t('panel.frp.title')}</p>
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.frpProviders.configHint')}</p>
          <textarea
            className="min-h-40 w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground focus-visible:outline-none"
            value={text}
            placeholder={t('panel.frp.configLabel')}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
          />
          {address ? <p className="text-xs text-success">{t('panel.frpProviders.address', { address })}</p> : null}
          {status.frp?.error ? <p className="text-xs text-error">{status.frp.error}</p> : null}
          {note ? <p className="text-xs text-error">{note}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy !== ''} onClick={() => void stop()}>
              {t('panel.frp.stop')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy !== '' || !text.trim()} onClick={() => void save()}>
              {t('panel.frp.saveStart')}
            </Button>
          </div>
        </div>
      </Card>
    </>
  )
}
