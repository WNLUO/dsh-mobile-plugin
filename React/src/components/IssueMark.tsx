// 用途：异常提示入口；把这条已脱敏摘要直接提交到公开反馈接口，并把线程 key 就地回显。
/**
 * 异常提示入口：标签右边一颗红色感叹号，点开看全文，还能一键复制发给别人。
 *
 * 面板正文里不铺长篇报错——那会把卡片撑高、把别的行挤歪。所有「出了问题」的状态都收成
 * 这一个小入口：没问题时它不渲染，有问题时才出现在该行标签的右侧（跟着标题左对齐）。
 * 文案全走字典，详情原文一字不改地可复制；同一扇窗里还能把标题与详情作为已脱敏摘要
 * 直接提交给分发平台，不必先有 AI 工具、也不必配一台手机。
 */
import { Button } from '@appica/ui-react/button'
import { CopyButton } from '@appica/ui-react/copy-button'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@appica/ui-react/dialog'
import { useState } from 'react'

import { ApiError, apiGet, apiPost } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { useNotify } from '../lib/notify.ts'
import { InfoMark } from './InfoMark.tsx'

const FEEDBACK_PATH = '/api/relay/feedback/direct'
const DEVICE_ID_KEY = 'dsh-mobile-plugin.feedback.deviceId'
const SUBMIT_TIMEOUT_MS = 35_000
const submissionIds = new Map<string, string>()

function randomId(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/** 本机持久随机 id：存在浏览器本地，不读硬件指纹、不读密钥。 */
function localDeviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_ID_KEY)
    if (saved) return saved
    const id = randomId()
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return randomId()
  }
}

/** 同一条反馈重试复用同一个 submission_id。 */
function submissionIdOf(text: string): string {
  if (!submissionIds.has(text)) submissionIds.set(text, randomId())
  return submissionIds.get(text) as string
}

/** 插件版本由宿主的状态口给出；读不到就交空串，不编一个版本出来。 */
async function componentVersion(): Promise<string> {
  try {
    const status = await apiGet<{ appVersion?: string }>('/api/relay/status')
    return status.appVersion || ''
  } catch {
    return ''
  }
}

export type FeedbackDraft = {
  /** 已脱敏的摘要：标题 + 详情，或一处报错的来龙去脉。 */
  summary: string
  /** 诊断文本，作为 text/plain 附件；只含插件自己能看到的读数。 */
  detail: string
  /** JSON 诊断摘要里的额外几格。 */
  context?: Record<string, unknown>
  /** 调用方已经读到版本时直接带上，省一次状态读取。 */
  version?: string
}

export type FeedbackResult = { threadKey: string; submissionId: string }

/**
 * 就地反馈：先把草稿交给本机同源接口，由 Node 侧拼表单并发到分发平台。
 * 浏览器直连平台会触发跨域（面板来自 127.0.0.1，平台只放行自己站点），请求其实到了、
 * 响应却读不到，只抛一句 Failed to fetch —— 用户看到假失败还会重发。
 */
export async function submitDirectFeedback(draft: FeedbackDraft): Promise<FeedbackResult> {
  const version = draft.version ?? (await componentVersion())
  const submissionId = submissionIdOf(draft.summary)
  try {
    const result = await apiPost<FeedbackResult>(FEEDBACK_PATH, {
      summary: draft.summary,
      detail: draft.detail,
      context: draft.context || {},
      version,
      deviceId: localDeviceId(),
      submissionId,
    }, { timeoutMs: SUBMIT_TIMEOUT_MS })
    if (!result?.threadKey) throw new Error(t('panel.feedback.noKey'))
    // 成功后清掉：同文案下次提交是新反馈，不能被平台当成重试返回旧线程。
    // 失败时保留，重试沿用同一个号；在途的重复点击此前已取到同一个号，不受影响。
    submissionIds.delete(draft.summary)
    return { threadKey: result.threadKey, submissionId: result.submissionId || submissionId }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'request_timeout') throw new Error(t('panel.feedback.timeout'))
    throw error
  }
}

export type Issue = {
  /** 弹窗标题：一般是所在行的标签，已走字典。 */
  title: string
  /** 详情全文，原样可复制。 */
  detail: string
  /** 失败发生时的固定状态读数，不含凭据或会话内容。 */
  facts?: Record<string, string>
}

export function IssueMark({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [threadKey, setThreadKey] = useState('')
  const [feedbackFor, setFeedbackFor] = useState('')
  const summary = `${issue.title}\n${issue.detail}`
  const [sendError, setSendError] = useState('')
  const notify = useNotify()

  async function send() {
    if (sending) return
    setSending(true)
    setFeedbackFor(summary)
    setThreadKey('')
    setSendError('')
    try {
      const result = await submitDirectFeedback({
        summary: `${issue.title}\n${issue.detail}`,
        detail: [`${issue.title}\n${issue.detail}`,
          ...Object.entries(issue.facts || {}).map(([key, value]) => `${key}=${value}`)].join('\n'),
        context: { ...issue.facts, title: issue.title, detail: issue.detail },
      })
      setThreadKey(result.threadKey)
    } catch (error) {
      setSendError(t('panel.feedback.failed', { error: (error as Error).message || String(error) }))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={issue.title}
        title={issue.title}
        className="-m-1 inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-1 text-error transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        onClick={() => setOpen(true)}
      >
        <InfoMark />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" closeLabel={t('panel.common.close')}>
          <DialogHeader>
            <DialogTitle>{issue.title}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="whitespace-pre-wrap break-all text-sm leading-6 text-foreground-muted">{issue.detail}</p>
            <p className="mt-2 text-xs leading-5 text-foreground-muted">{t('panel.feedback.consent')}</p>
            {feedbackFor === summary && sendError ? <p className="mt-2 text-sm text-error">{sendError}</p> : null}
            {feedbackFor === summary && threadKey ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-xs leading-5 text-foreground-muted">
                  {t('panel.feedback.receipt', { key: threadKey })}
                </p>
                <CopyButton
                  value={threadKey}
                  label={t('panel.feedback.copyKey')}
                  copiedLabel={t('panel.feedback.keyCopied')}
                  size="sm"
                  variant="outline"
                  onCopyError={() => notify('error', t('panel.feedback.keyCopyFailed'))}
                >
                  {t('panel.feedback.copyKey')}
                </CopyButton>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => void send()}
            >
              {sending ? t('panel.feedback.sending') : t('panel.feedback.sendThis')}
            </Button>
            <CopyButton
              value={issue.detail}
              label={t('panel.common.copy')}
              copiedLabel={t('panel.links.sponsorCopied')}
              size="sm"
              variant="outline"
              onCopyError={() => notify('error', t('panel.onboarding.copiedFailed'))}
            >
              {t('panel.common.copy')}
            </CopyButton>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('panel.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
