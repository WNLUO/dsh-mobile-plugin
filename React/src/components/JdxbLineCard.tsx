// 节点小宝线路卡：本机设备端装没装 / 绑没绑、取绑定链接、把控制台分到的外网地址记下来。
// 设备端是以系统服务装进机器的，插件不启动也不管理它的进程，所以这一卡只做两件事：
// 读它的状态（含绑定链接），以及把用户抄来的「域名:端口」写进线路清单。
import { useEffect, useState } from 'react'

import { Button } from '@appica/ui-react/button'
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Input } from '@appica/ui-react/input'

import { jdxbBind, jdxbInstall, jdxbSetUrl, jdxbStatus, type JdxbStatus } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

export function JdxbLineCard() {
  /** 设备端此刻的状态；null = 还没读到（或接口不通）。 */
  const [status, setStatus] = useState<JdxbStatus | null>(null)
  /** 地址栏的值：初值取已落盘的那条，用户改动后以输入为准。 */
  const [url, setUrl] = useState('')
  /** 这一卡自己的结果提示（保存成功 / 取链接失败）。 */
  const [note, setNote] = useState('')
  /** 地址写成不合法时，红字提示走它而不是 note（两条提示别叠在一起）。 */
  const [badUrl, setBadUrl] = useState('')
  const [installBusy, setInstallBusy] = useState(false)
  const [bindBusy, setBindBusy] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  /** 取到的绑定链接；空 = 还没取 / 已经绑过了。 */
  const [bindLink, setBindLink] = useState('')

  // 打开这一页时读一次：设备端在不在、绑没绑、已填的地址是什么。只读，不改任何东西。
  useEffect(() => {
    let cancelled = false
    jdxbStatus()
      .then((snapshot) => {
        if (cancelled) return
        setStatus(snapshot)
        setUrl(snapshot.url || '')
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 一键安装：下载官方设备端、装成系统服务并拉起。中间会弹一次系统授权框。 */
  async function install() {
    setInstallBusy(true)
    setNote('')
    try {
      const result = await jdxbInstall()
      if (result.ok) {
        setNote(t('panel.jdxb.installed'))
      } else {
        setNote(result.error || t('panel.jdxb.bindFailed'))
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      // 不管成没成，状态都以宿主那边为准：装了一半、装完没起来，都别让面板自己猜。
      try { setStatus(await jdxbStatus()) } catch {}
      setInstallBusy(false)
    }
  }

  async function takeBindLink() {
    setBindBusy(true)
    setNote('')
    try {
      const result = await jdxbBind()
      if (result.ok && result.url) {
        setBindLink(result.url)
        setStatus((previous) => (previous ? { ...previous, bound: false } : previous))
      } else if (result.bound) {
        // 它在回包前刚绑上：把状态改成已绑，别再让用户点这一颗。
        setStatus((previous) => (previous ? { ...previous, bound: true } : previous))
        setNote('')
      } else {
        setNote(`${t('panel.jdxb.bindFailed')}${result.error ? ` · ${result.error}` : ''}`)
      }
    } catch (error) {
      setNote(`${t('panel.jdxb.bindFailed')}${error instanceof Error ? ` · ${error.message}` : ''}`)
    } finally {
      setBindBusy(false)
    }
  }

  async function save() {
    setSaveBusy(true)
    setNote('')
    setBadUrl('')
    try {
      const result = await jdxbSetUrl(url)
      if (result.ok) {
        setUrl(result.url)
        setStatus((previous) => (previous ? { ...previous, url: result.url } : previous))
        setNote(result.url ? t('panel.jdxb.saved') : t('panel.jdxb.cleared'))
      } else {
        setBadUrl(t('panel.jdxb.badUrl'))
      }
    } catch (error) {
      setBadUrl(error instanceof Error ? error.message : String(error))
    } finally {
      setSaveBusy(false)
    }
  }

  const stateText = !status
    ? ''
    : !status.supported
      ? t('panel.jdxb.unsupported')
      : !status.installed
        ? t('panel.jdxb.notInstalled')
        : !status.bound
          ? t('panel.jdxb.unbound')
          : t('panel.jdxb.bound')

  return (
    <section className="flex flex-col gap-3">
      <Field className="border-t border-border-muted pt-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <FieldLabel>{t('panel.jdxb.section')}</FieldLabel>
          <span className="max-w-[62%] text-right text-xs leading-tight text-foreground-muted">
            {t('panel.jdxb.hint')}
          </span>
        </div>
        {stateText ? (
          <p className="mt-1 text-xs text-foreground-muted">
            {stateText}
            {status?.installed && status.error ? ` · ${status.error}` : ''}
          </p>
        ) : null}
        {/* 没装或装了没起：插件自己装、自己拉，用户只用点这一颗并在系统授权框里确认。 */}
        {status && status.supported && (!status.service?.installed || !status.installed) ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={installBusy} onClick={install}>
              {installBusy ? t('panel.jdxb.installing') : status.service?.installed ? t('panel.jdxb.start') : t('panel.jdxb.install')}
            </Button>
            <span className="text-xs text-foreground-muted">{t('panel.jdxb.installHint')}</span>
          </div>
        ) : null}
        {/* 只在「装了但没绑」时给这颗：已绑的设备拿不到链接，没装时点了也没用。 */}
        {status?.installed && !status.bound ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={bindBusy} onClick={takeBindLink}>
              {bindBusy ? t('panel.jdxb.binding') : t('panel.jdxb.bind')}
            </Button>
            {bindLink ? (
              <a
                href={bindLink}
                target="_blank"
                rel="noreferrer"
                className="break-all text-xs underline text-foreground-muted"
              >
                {bindLink}
              </a>
            ) : null}
          </div>
        ) : null}
        {badUrl ? <p className="mt-1 text-xs text-error">{badUrl}</p> : null}
        {note ? <p className="mt-1 text-xs text-foreground-muted">{note}</p> : null}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Input
            inputProps={{ className: 'font-mono', 'aria-label': t('panel.jdxb.urlLabel') }}
            value={url}
            placeholder={t('panel.jdxb.urlPlaceholder')}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button variant="outline" size="sm" disabled={saveBusy} onClick={save}>
            {saveBusy ? t('panel.jdxb.saving') : t('panel.jdxb.save')}
          </Button>
        </div>
      </Field>
    </section>
  )
}
