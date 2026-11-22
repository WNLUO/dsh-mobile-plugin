// 国内线路页：ZeroNews 与节点小宝。两条都只对国内用户有意义（注册与节点都在国内）。
/**
 * 「中国线路」子页（2026-11-23 用户要求：线路按地区分页）。
 *
 * 内容就是原来摊在网络配置页底部的两段：ZeroNews 公网入口与节点小宝那条 TCP 线路。
 * 挪出来不是为了好看 —— 后面国内服务商还会加，把它们留在主配置页里，那一页会越接越长，
 * 而海外用户根本用不上。
 *
 * 返回按钮回主配置页（`#network`），地址由外层 Console 换。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { useState } from 'react'

import type { StatusView } from '../lib/api.ts'
import { zeroNewsConnect, zeroNewsDisconnect } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { JdxbLineCard } from './JdxbLineCard.tsx'

type Props = {
  open: boolean
  /** 返回（false）或没有动作；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
}

export function ChinaLinesPage({ open, onOpenChange, status, busy }: Props) {
  /** ZeroNews 线路操作的结果提示（连接成功 / 失败原因）。 */
  const [zeroNewsNote, setZeroNewsNote] = useState('')
  /** ZeroNews 线路连接 / 断开进行中（整条链要下载+登录+建隧道，可能几分钟）。 */
  const [zeroNewsLinkBusy, setZeroNewsLinkBusy] = useState(false)
  const canSave = busy === ''

  /**
   * ZeroNews 线路连接：插件自动下载客户端、拉浏览器登录（不用 token）、建隧道、拿域名上报。
   * 可能要几分钟（等浏览器确认），期间按钮转圈；回包里的 error 原样显示，不吞原因。
   */
  async function connectZeroNews() {
    setZeroNewsLinkBusy(true)
    setZeroNewsNote('')
    try {
      const res = await zeroNewsConnect()
      const note = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && note) setZeroNewsNote(note)
      else if (res.phase === 'connected') setZeroNewsNote(t('panel.zeronews.linkOn', { url: res.url || '' }))
      else if (note) setZeroNewsNote(note)
    } catch (error) {
      setZeroNewsNote(error instanceof Error ? error.message : String(error))
    } finally {
      setZeroNewsLinkBusy(false)
    }
  }

  /** ZeroNews 线路断开：停客户端、撤域名。 */
  async function disconnectZeroNews() {
    setZeroNewsLinkBusy(true)
    setZeroNewsNote('')
    try {
      const res = await zeroNewsDisconnect()
      const note = typeof res.error === 'string' ? res.error : res.error?.message
      if (!res.ok && note) setZeroNewsNote(note)
    } catch (error) {
      setZeroNewsNote(error instanceof Error ? error.message : String(error))
    } finally {
      setZeroNewsLinkBusy(false)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.pairing.openConfig')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.region.china')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.region.chinaPageHint')}</p>

          <Field>
            {/* 标题 + 登录流程提示同一行，节省竖向空间（2026-11-22 用户要求）。 */}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <FieldLabel>{t('panel.zeronews.section')}</FieldLabel>
              <span className="max-w-[62%] text-right text-xs leading-tight text-foreground-muted">
                {t('panel.zeronews.linkHint')}
              </span>
            </div>
            {status.zeroNews?.error ? <p className="mt-1 text-xs text-error">{status.zeroNews.error}</p> : null}
            {zeroNewsNote ? <p className="mt-1 text-xs text-error">{zeroNewsNote}</p> : null}
            {/* 已连接 / 地址左对齐，连接 / 断开两颗按钮靠右。 */}
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
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
                <Button variant="outline" size="sm" disabled={!canSave || zeroNewsLinkBusy || status.zeroNews?.phase === 'connected'} onClick={connectZeroNews}>
                  {zeroNewsLinkBusy ? t('panel.zeronews.linkConnecting') : t('panel.zeronews.linkConnect')}
                </Button>
                <Button variant="ghost" size="sm" disabled={!canSave || zeroNewsLinkBusy || status.zeroNews?.phase !== 'connected'} onClick={disconnectZeroNews}>
                  {t('panel.zeronews.linkDisconnect')}
                </Button>
              </div>
            </div>
          </Field>

          {/* 节点小宝那条 TCP 线路：设备端装没装、绑没绑、地址写没写（见 JdxbLineCard.tsx）。 */}
          <JdxbLineCard />
        </div>
      </Card>
    </>
  )
}
