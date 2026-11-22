// ZeroNews 线路页：打开控制台 → 复制 AuthToken → 粘进来保存，插件自己建隧道并取回地址。
/**
 * ZeroNews 的配置页（2026-11-23：改成「AuthToken 粘贴」这一条主路）。
 *
 * 为什么不再靠浏览器登录：新机器第一次用时，客户端根本没有身份，光点「连接」只会去拉一个
 * 什么都确认不了的浏览器窗口 —— 实际要的是控制台「快速开始」页上那串账户 AuthToken。
 * 现在页面上把顺序写清楚、配一张截图，用户复制粘贴一次，剩下的下载、启动、建隧道、读域名
 * 还是插件自己做。
 *
 * token 只经这一次请求进到宿主内存、由官方 CLI 写进本机客户端配置；面板不留、不存、不显示。
 *
 * 返回按钮回「中国」页（`#network/cn`），地址由外层 Console 换。
 */
import { Button, buttonVariants } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Input } from '@appica/ui-react/input'
import { useEffect, useState } from 'react'

import setupShot from '../assets/zeronews-authtoken.jpg'
import type { StatusView } from '../lib/api.ts'
import { zeroNewsConnect, zeroNewsDisconnect } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { LineGuide } from './LineGuide.tsx'

/** ZeroNews 控制台的「快速开始」页：登录后就在拿到 AuthToken 的地方。 */
const CONSOLE_URL = 'https://user.zeronews.cc/setup'

type Props = {
  open: boolean
  /** 返回（false）回地区页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
}

export function ZeroNewsPage({ open, onOpenChange, status, busy }: Props) {
  /** 用户粘贴的 AuthToken：只在这一页的内存里，保存成功后立刻清掉。 */
  const [token, setToken] = useState('')
  /** 线路操作的结果提示（连接成功 / 失败原因）。 */
  const [note, setNote] = useState('')
  /** 连接 / 断开进行中（整条链要下载客户端、建隧道，可能几分钟）。 */
  const [linkBusy, setLinkBusy] = useState(false)
  const canSave = busy === ''

  // 关页时把上一轮的结果与没交出去的 token 一起清掉，别留在内存里。
  useEffect(() => {
    if (!open) {
      setNote('')
      setToken('')
    }
  }, [open])

  /**
   * 保存并连接：把 token 交给宿主，之后的下载、启动、建隧道、读域名都在那边做。
   * 没填 token 时也允许点 —— 这台机器早就登录过的话，宿主会走「已登录」那条快路。
   */
  async function connect() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsConnect(token.trim() || undefined)
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      else if (res.phase === 'connected') {
        setToken('')
        setNote(t('panel.zeronews.linkOn', { url: res.url || '' }))
      } else if (error) setNote(error)
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

  // 三步与页面上的动作一一对应；`activeIndex` 按宿主的连接阶段走，没报阶段就停在第一步。
  const steps = [
    { title: t('panel.guide.zeronews.step1'), body: t('panel.guide.zeronews.step1Body') },
    { title: t('panel.guide.zeronews.step2'), body: t('panel.guide.zeronews.step2Body') },
    { title: t('panel.guide.zeronews.step3'), body: t('panel.guide.zeronews.step3Body') },
  ]
  const phase = status.zeroNews?.phase
  const activeIndex = phase === 'connected' ? steps.length : phase && phase !== 'off' ? 2 : 0
  const connected = phase === 'connected'

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

          {/* 截图给的是「去哪儿复制」：控制台里「快速开始」页上那串 AuthToken 与右边的复制按钮。 */}
          <figure className="flex flex-col gap-1">
            <img
              src={setupShot}
              alt={t('panel.zeronews.guideCaption')}
              className="w-full rounded-md border border-border-muted"
            />
            <figcaption className="text-xs text-foreground-muted">{t('panel.zeronews.guideCaption')}</figcaption>
          </figure>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <a href={CONSOLE_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {t('panel.zeronews.openConsole')}
            </a>
            <span className="text-xs text-foreground-muted">
              {connected
                ? t('panel.zeronews.linkOn', { url: status.zeroNews?.url || '' })
                : phase === 'error'
                  ? t('panel.zeronews.linkError')
                  : phase && phase !== 'off'
                    ? t('panel.zeronews.linkBusy')
                    : t('panel.zeronews.linkOff')}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sm text-foreground-strong">{t('panel.zeronews.tokenLabel')}</span>
            <Input
              inputProps={{ className: 'font-mono' }}
              value={token}
              placeholder={t('panel.zeronews.tokenPlaceholder')}
              onChange={(event) => setToken(event.target.value)}
            />
            <p className="text-xs text-foreground-muted">{t('panel.zeronews.tokenHint')}</p>
          </div>

          {status.zeroNews?.error ? <p className="text-xs text-error">{status.zeroNews.error}</p> : null}
          {note ? <p className="text-xs text-error">{note}</p> : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={!canSave || linkBusy || !connected} onClick={disconnect}>
              {t('panel.zeronews.linkDisconnect')}
            </Button>
            <Button variant="primary" size="sm" disabled={!canSave || linkBusy} onClick={connect}>
              {linkBusy ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.tokenSave')}
            </Button>
          </div>
        </div>
      </Card>
    </>
  )
}
