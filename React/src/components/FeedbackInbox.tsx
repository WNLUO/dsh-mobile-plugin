// 读取本机反馈历史和官方回复，按原线程补充信息并保留未发送草稿。
import { Button } from '@appica/ui-react/button'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@appica/ui-react/dialog'
import { Input } from '@appica/ui-react/input'
import { Textarea } from '@appica/ui-react/textarea'
import { useEffect, useRef, useState } from 'react'

import { errorText } from '../lib/api.ts'
import {
  FEEDBACK_CHANGED, FEEDBACK_OPEN, readFeedbackThread, rememberFeedbackThread,
  replyFeedbackThread, savedFeedbackThreads, type FeedbackThread,
} from '../lib/feedback.ts'
import { t } from '../lib/i18n/index.ts'

export function FeedbackInbox() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(savedFeedbackThreads)
  const [key, setKey] = useState('')
  const [importKey, setImportKey] = useState('')
  const [thread, setThread] = useState<FeedbackThread | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef(0)

  useEffect(() => {
    const changed = () => setRows(savedFeedbackThreads())
    const show = (event: Event) => {
      request.current += 1
      setLoading(false)
      setKey((event as CustomEvent<string>).detail || '')
      setThread(null)
      setError('')
      setNotice('')
      setOpen(true)
    }
    window.addEventListener(FEEDBACK_CHANGED, changed)
    window.addEventListener(FEEDBACK_OPEN, show)
    return () => {
      window.removeEventListener(FEEDBACK_CHANGED, changed)
      window.removeEventListener(FEEDBACK_OPEN, show)
    }
  }, [])

  async function load(target: string) {
    const turn = ++request.current
    setLoading(true)
    setError('')
    try {
      const value = await readFeedbackThread(target)
      if (turn !== request.current) return
      setThread(value)
      const title = value.messages.find((message) => message.author === 'user')?.content || target
      try { rememberFeedbackThread(target, title) }
      catch { setNotice(t('panel.feedback.storageFailed')) }
    } catch (failure) {
      if (turn === request.current) setError(errorText(failure))
    } finally {
      if (turn === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (open && key) void load(key)
    return () => { request.current += 1 }
  }, [open, key])

  function select(target: string) {
    setThread(null)
    setError('')
    setNotice('')
    if (target && target === key) void load(target)
    else setKey(target)
  }

  async function send() {
    const content = (drafts[key] || '').trim()
    if (!content || sending) return
    const target = key
    setSending(true)
    setError('')
    setNotice('')
    try {
      await replyFeedbackThread(target, content)
      setDrafts((current) => ({ ...current, [target]: '' }))
      setNotice(t('panel.feedback.replySent'))
      await load(target)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSending(false)
    }
  }

  const draft = drafts[key] || ''
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!sending) setOpen(next) }}>
      <DialogContent className="max-w-2xl" closeLabel={t('panel.common.close')}>
        <DialogHeader><DialogTitle>{t('panel.feedback.history')}</DialogTitle></DialogHeader>
        <DialogBody className="flex flex-col gap-3 overflow-y-auto">
          {!key ? (
            <>
              {rows.length === 0 ? <p className="text-sm text-foreground-muted">{t('panel.feedback.empty')}</p> : null}
              {rows.map((row) => (
                <Button key={row.key} variant="outline" onClick={() => select(row.key)} className="justify-start truncate">
                  {row.title}{' · '}{row.key.slice(-8)}
                </Button>
              ))}
              <label className="text-sm text-foreground-muted" htmlFor="feedback-import-key">{t('panel.feedback.importHint')}</label>
              <Input inputProps={{ id: 'feedback-import-key', autoComplete: 'off' }} value={importKey}
                onChange={(event) => setImportKey(event.target.value)} />
              <Button variant="outline" size="sm" disabled={!importKey.trim()} onClick={() => select(importKey.trim())}>
                {t('panel.feedback.openThread')}
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" disabled={sending} onClick={() => select('')}>{t('panel.feedback.back')}</Button>
                <Button variant="outline" size="sm" disabled={loading || sending} onClick={() => void load(key)}>
                  {t(loading ? 'panel.feedback.loading' : 'panel.feedback.refresh')}
                </Button>
              </div>
              <p className="break-all text-xs text-foreground-muted">{t('panel.feedback.keyLabel', { key })}</p>
              {thread ? (
                <div className="max-h-80 space-y-3 overflow-y-auto" aria-live="polite">
                  {thread.messages.map((message) => (
                    <div key={message.id} className="border-b border-border-muted pb-3">
                      <p className="text-xs text-foreground-muted">
                        {t(message.author === 'staff' ? 'panel.feedback.staff' : 'panel.feedback.you')}
                        {' · '}{message.created_at}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              {thread ? (
                <>
                  <label className="text-sm text-foreground-muted" htmlFor="feedback-reply">{t('panel.feedback.reply')}</label>
                  <Textarea id="feedback-reply" rows={4} maxLength={4000} value={draft} disabled={sending}
                    onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
                  <Button variant="primary" disabled={!draft.trim() || sending || loading} onClick={() => void send()}>
                    {t(sending ? 'panel.feedback.sending' : 'panel.feedback.sendReply')}
                  </Button>
                </>
              ) : null}
            </>
          )}
          {error ? <p className="text-sm text-error" role="alert">{error}</p> : null}
          {notice ? <p className="text-sm text-foreground-muted" role="status">{notice}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={sending} onClick={() => setOpen(false)}>{t('panel.common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
