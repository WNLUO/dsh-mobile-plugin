/**
 * 「FRP 导入」弹窗：把一段 frpc 配置粘进来，认出公网入口填回地址栏，并让宿主真正把 frpc 跑起来。
 *
 * 两件事一起做，因为光填地址而不启动隧道，APP 拨过去只会是空门：
 *   · 解析（纯函数 `lib/frp-config.ts`）：认出 tcp 转发（进「TCP 直连地址」）或 https 域名（进「直连地址」）；
 *   · 启动：把配置原文交给宿主（`/api/relay/frp/import`），宿主把 `localPort` 对齐到插件实际端口后
 *     起 `frpc -c 配置`。起不来就把原因摆在这儿，不无脑说「已导入」。
 *
 * 只粘了一段 `主机:端口` 时只填地址、不启动（那不是 frpc 配置，起也会失败）。
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
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Textarea } from '@appica/ui-react/textarea'
import { useEffect, useMemo, useState } from 'react'

import { errorText, importFrp } from '../lib/api.ts'
import { parseFrpConfig } from '../lib/frp-config.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 解析成功后把「填哪个栏、填什么」交给调用方。 */
  onImport: (result: { field: 'tcp' | 'direct'; value: string }) => void
}

/** 这段文本像不像一份 frpc 配置（而不是只有一行地址）。只有配置才值得交给宿主去起 frpc。 */
function looksLikeConfig(text: string): boolean {
  return /serverAddr|server_addr|\[\[\s*proxies\s*\]\]|\[common\]/i.test(text)
}

export function FrpImportDialog({ open, onOpenChange, onImport }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const parsed = useMemo(() => parseFrpConfig(text), [text])

  // 每次开窗清掉上一次的失败信息，别把上一轮的红字带进来。
  useEffect(() => {
    if (open) setError('')
  }, [open])

  async function submit() {
    if (!parsed.ok || busy) return
    setError('')
    let remoteAddress = ''
    if (looksLikeConfig(text)) {
      setBusy(true)
      try {
        const result = await importFrp(text)
        if (result?.status && result.status.error) {
          setError(result.status.error)
          setBusy(false)
          return
        }
        remoteAddress = result?.status?.remoteAddress || ''
      } catch (err) {
        setError(errorText(err))
        setBusy(false)
        return
      }
      setBusy(false)
    }
    // frpc 读到了服务端实际分配的公网地址，就用它；否则退回解析出来的（可能只是本机端口推断）。
    const value = parsed.field === 'tcp' && remoteAddress ? remoteAddress : parsed.value
    onImport({ field: parsed.field, value })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,92vw)]">
        <DialogHeader>
          <DialogTitle>{t('panel.frp.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.frp.hint')}</p>
          <Field>
            <FieldLabel htmlFor="frp-import">{t('panel.frp.label')}</FieldLabel>
            <Textarea
              id="frp-import"
              rows={6}
              value={text}
              onChange={(event) => setText(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {text.trim() ? (
            parsed.ok ? (
              <>
                <p role="status" className="text-xs text-foreground-muted">
                  {t(parsed.field === 'tcp' ? 'panel.frp.detectedTcp' : 'panel.frp.detectedDirect', { address: parsed.value })}
                </p>
                {parsed.note === 'inferred-local-port' ? (
                  <p className="text-xs text-foreground-muted">{t('panel.frp.inferredPort', { port: parsed.port ?? '' })}</p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-error">{t(parsed.reason === 'empty' ? 'panel.frp.empty' : 'panel.frp.badFormat')}</p>
            )
          ) : null}
          {error ? <p className="text-xs text-error">{error}</p> : null}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('panel.common.cancel')}
          </Button>
          <Button variant="primary" disabled={!parsed.ok || busy} onClick={submit}>
            {t('panel.frp.fill')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
