// ZeroNews 线路页：第一次接入才要装客户端、复制 AuthToken；接好之后这一页只剩状态与连接 / 断开。
/**
 * ZeroNews 的配置页（2026-11-23：第一次接入才要 token）。
 *
 * 为什么分成两副面孔：新机器第一次用时，客户端还没有身份，必须走一遍「装客户端 → 登录 →
 * 复制 AuthToken → 粘回来」；而接好之后这些步骤一个字都不用再看，再摆一个粘贴框只会让人以为
 * 每次都要粘。所以「有没有身份」由宿主答（`zeroNews.configured`，落盘，不含凭据）：
 *
 *   · 没身份：步骤条 + 截图 + 一颗「开始接入」（装好客户端、打开登录页）→ 粘 token 保存；
 *   · 有身份：只有状态与「连接 / 断开」。
 *
 * token 只经一次请求进到宿主内存、由官方 CLI 写进本机客户端配置；面板不留、不存、不显示。
 *
 * 返回按钮回「中国」页（`#network/cn`），地址由外层 Console 换。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Input } from '@appica/ui-react/input'
import { useEffect, useState } from 'react'

import setupShot from '../assets/zeronews-authtoken.jpg'
import type { StatusView } from '../lib/api.ts'
import { zeroNewsConnect, zeroNewsDisconnect, zeroNewsPrepare } from '../lib/api.ts'
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
  /** 用户粘贴的 AuthToken：只在这一页的内存里，保存成功后立刻清掉。 */
  const [token, setToken] = useState('')
  /** 线路操作的结果提示（连接成功 / 失败原因 / 浏览器没打开时的地址）。 */
  const [note, setNote] = useState('')
  /** 连接 / 断开 / 安装进行中。 */
  const [linkBusy, setLinkBusy] = useState(false)
  /** 这一页里点过「开始接入」没有：装完才把粘贴框亮出来。 */
  const [prepared, setPrepared] = useState(false)
  const canSave = busy === ''

  // 关页时把上一轮的结果与没交出去的 token 一起清掉，别留在内存里。
  useEffect(() => {
    if (!open) {
      setNote('')
      setToken('')
      setPrepared(false)
    }
  }, [open])

  /** 第一步：装客户端 + 打开登录页。下载可能要几十秒，装完才让人粘 token。 */
  async function prepare() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsPrepare()
      if (!res.ok) {
        setNote(res.error || t('panel.zeronews.linkError'))
        return
      }
      setPrepared(true)
      if (!res.opened && res.url) setNote(t('panel.zeronews.openFailed', { url: res.url }))
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 第二步：把 token 交给宿主，之后的启动、建隧道、读域名都在那边做。 */
  async function connect() {
    if (linkBusy || !token.trim()) return
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsConnect(token.trim())
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
      else if (res.phase === 'connected') {
        setToken('')
        setPrepared(false)
        setNote(t('panel.zeronews.linkOn', { url: res.url || '' }))
      } else if (error) setNote(error)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setLinkBusy(false)
    }
  }

  /** 已经接好之后的重新连接：客户端配置里还留着身份，不用再给 token。 */
  async function reconnect() {
    if (linkBusy) return
    setLinkBusy(true)
    setNote('')
    try {
      const res = await zeroNewsConnect()
      const error = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && error) setNote(error)
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

  const phase = status.zeroNews?.phase
  const connected = phase === 'connected'
  const configured = status.zeroNews?.configured === true || connected
  const busyPhase = Boolean(phase && phase !== 'off' && phase !== 'error' && phase !== 'connected')
  const statusText = connected
    ? t('panel.zeronews.linkOn', { url: status.zeroNews?.url || '' })
    : phase === 'error'
      ? t('panel.zeronews.linkError')
      : busyPhase
        ? t('panel.zeronews.linkBusy')
        : t('panel.zeronews.linkOff')

  const steps = prepared
    ? [
        { title: t('panel.guide.zeronews.step3'), body: t('panel.guide.zeronews.step3Body') },
      ]
    : [
        { title: t('panel.guide.zeronews.step1'), body: t('panel.guide.zeronews.step1Body') },
        { title: t('panel.guide.zeronews.step2'), body: t('panel.guide.zeronews.step2Body') },
        { title: t('panel.guide.zeronews.step3'), body: t('panel.guide.zeronews.step3Body') },
      ]

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
          {configured ? (
            <>
              {/* 接好之后只留状态和两颗按钮：粘贴框、步骤、截图都收起来，免得像是每次都要重来。 */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-foreground-muted">{statusText}</span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" disabled={!canSave || linkBusy || !connected} onClick={disconnect}>
                    {t('panel.zeronews.linkDisconnect')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={!canSave || linkBusy || connected} onClick={reconnect}>
                    {linkBusy ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.linkConnect')}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <LineGuide steps={steps} />
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

              {prepared ? (
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
              ) : null}

              {status.zeroNews?.error ? <p className="text-xs text-error">{status.zeroNews.error}</p> : null}
              {note ? <p className="text-xs text-error">{note}</p> : null}

              <div className="flex flex-wrap items-center justify-end gap-2">
                {prepared ? (
                  <Button variant="primary" size="sm" disabled={!canSave || linkBusy || !token.trim()} onClick={connect}>
                    {linkBusy ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.tokenSave')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" disabled={!canSave || linkBusy} onClick={prepare}>
                    {linkBusy ? t('panel.zeronews.preparing') : t('panel.zeronews.prepare')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </Card>
    </>
  )
}
