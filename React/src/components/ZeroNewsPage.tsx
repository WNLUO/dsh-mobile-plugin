// ZeroNews 线路页：连接 / 断开、拿公网入口。原先在「中国」页里，现在那页只放服务商入口。
/**
 * ZeroNews 的配置页（2026-11-23 用户要求：地区下面按服务商分页）。
 *
 * 这条线路的特点写在文案里：不用注册、不用填 token，点连接后插件自己下载客户端、拉浏览器
 * 登录、建隧道，然后把分到的域名写回线路清单。所以这一页只有状态与两颗按钮，没有输入框。
 *
 * 返回按钮回「中国」页（`#network/cn`），地址由外层 Console 换。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { useEffect, useState } from 'react'

import type { StatusView } from '../lib/api.ts'
import { zeroNewsConnect, zeroNewsDisconnect } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { LineGuide } from './LineGuide.tsx'

type Props = {
  open: boolean
  /** 返回（false）回地区页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
}

export function ZeroNewsPage({ open, onOpenChange, status, busy }: Props) {
  /** 线路操作的结果提示（连接成功 / 失败原因）。 */
  const [note, setNote] = useState('')
  /** 连接 / 断开进行中（整条链要下载+登录+建隧道，可能几分钟）。 */
  const [linkBusy, setLinkBusy] = useState(false)
  const canSave = busy === ''

  // 关页时把上一轮的结果清掉：下次进来应该只看此刻的状态，不该挂着上次那句。
  useEffect(() => {
    if (!open) setNote('')
  }, [open])

  /**
   * 连接：插件自动下载客户端、拉浏览器登录（不用 token）、建隧道、拿域名上报。
   * 可能要几分钟（等浏览器确认），期间按钮转圈；回包里的 error 原样显示，不吞原因。
   */
  async function connect() {
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsConnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      else if (res.phase === 'connected') setNote(t('panel.zeronews.linkOn', { url: res.url || '' }))
      else if (error) setNote(error)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 断开：停客户端、撤域名。 */
  async function disconnect() {
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsDisconnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
    }
  }

  if (!open) return null

  // 三步与卡片上的动作一一对应；`activeIndex` 按宿主的连接阶段走，遇到底层没报阶段就停在第一步。
  const steps = [
    { title: t('panel.guide.zeronews.step1'), body: t('panel.guide.zeronews.step1Body') },
    { title: t('panel.guide.zeronews.step2'), body: t('panel.guide.zeronews.step2Body') },
    { title: t('panel.guide.zeronews.step3'), body: t('panel.guide.zeronews.step3Body') },
  ]
  const phase = status.zeroNews?.phase
  const activeIndex = phase === 'connected' ? steps.length : phase && phase !== 'off' ? 1 : 0

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.region.china')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.provider.zeronews')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <LineGuide steps={steps} activeIndex={activeIndex} />
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.zeronews.linkHint')}</p>
          {status.zeroNews?.error ? <p className="text-xs text-error">{status.zeroNews.error}</p> : null}
          {note ? <p className="text-xs text-error">{note}</p> : null}
          {/* 已连接 / 地址左对齐，连接 / 断开两颗按钮靠右。 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-foreground-muted">
              {status.zeroNews?.phase === 'connected'
                ? t('panel.zeronews.linkOn', { url: status.zeroNews.url })
                : status.zeroNews?.phase === 'error'
                  ? t('panel.zeronews.linkError')
                  : status.zeroNews?.phase && status.zeroNews.phase !== 'off'
                    ? t('panel.zeronews.linkBusy')
                    : t('panel.zeronews.linkOff')}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!canSave || linkBusy || status.zeroNews?.phase === 'connected'} onClick={connect}>
                {linkBusy ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.linkConnect')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!canSave || linkBusy || status.zeroNews?.phase !== 'connected'} onClick={disconnect}>
                {t('panel.zeronews.linkDisconnect')}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </>
  )
}
