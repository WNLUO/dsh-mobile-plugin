/** FRP 子窗只解析并暂存；父窗保存配置时才启动隧道，取消不会产生宿主副作用。 */
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

import { parseFrpConfig } from '../lib/frp-config.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 解析成功后把「填哪个栏、填什么」交给调用方。 */
  onImport: (result: { field: 'tcp' | 'direct'; value: string; config?: string }) => void
}

/** 这段文本像不像一份 frpc 配置（而不是只有一行地址）。只有配置才值得交给宿主去起 frpc。 */
function looksLikeConfig(text: string): boolean {
  return /serverAddr|server_addr|\[\[\s*proxies\s*\]\]|\[common\]/i.test(text)
}

export function FrpImportDialog({ open, onOpenChange, onImport }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const parsed = useMemo(() => parseFrpConfig(text), [text])

  // 每次开窗清掉上一次的失败信息，别把上一轮的红字带进来。
  useEffect(() => {
    if (open) setError('')
  }, [open])

  function submit() {
    if (!parsed.ok) return
    if (/^\s*\[common\]\s*$/im.test(text) || /^\s*server_addr\s*=/im.test(text)) {
      setError(t('panel.frp.iniUnsupported'))
      return
    }
    const value = parsed.value
    onImport({ field: parsed.field, value, ...(looksLikeConfig(text) ? { config: text } : {}) })
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('panel.common.cancel')}
          </Button>
          <Button variant="primary" disabled={!parsed.ok} onClick={submit}>
            {t('panel.frp.fill')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
