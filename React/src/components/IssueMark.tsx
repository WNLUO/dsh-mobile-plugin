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

import { apiGet } from '../lib/api.ts'
import { rememberFeedbackThread } from '../lib/feedback.ts'
import { FeedbackButton } from './FeedbackButton.tsx'
import { t } from '../lib/i18n/index.ts'
import { useNotify } from '../lib/notify.ts'
import { InfoMark } from './InfoMark.tsx'

const FEEDBACK_URL = 'https://app.wnluo.com/api/sdk/feedback'
const PRODUCT_SLUG = 'dsh-mobile'
const SOURCE = 'plugin'
const COMPONENT_ID = 'dsh-mobile-plugin'
const ATTACHMENT_NAME = 'diagnosis.txt'
const DEVICE_ID_KEY = 'dsh-mobile-plugin.feedback.deviceId'
const SUBMIT_TIMEOUT_MS = 30_000
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
 * 就地反馈：直接 POST 公开接口，不经 AI 工具、不用先看有没有配对手机。
 * 受影响手机的字段一律留空，device_id 用本机持久随机 id，来源标成 plugin。
 */
export async function submitDirectFeedback(draft: FeedbackDraft): Promise<FeedbackResult> {
  const version = draft.version ?? (await componentVersion())
  const submissionId = submissionIdOf(draft.summary)
  const context = {
    product_slug: PRODUCT_SLUG,
    source: SOURCE,
    component_id: COMPONENT_ID,
    component_version: version,
    device_source: 'install',
    files: { name: ATTACHMENT_NAME, type: 'text/plain' },
    ...(draft.context || {}),
  }
  const form = new FormData()
  for (const key of ['package_id', 'platform', 'version_name', 'build_number', 'model', 'system_version', 'channel']) {
    form.append(key, '')
  }
  form.append('device_id', localDeviceId())
  form.append('content', draft.summary)
  form.append('product_slug', PRODUCT_SLUG)
  form.append('source', SOURCE)
  form.append('component_id', COMPONENT_ID)
  form.append('component_version', version)
  form.append('submission_id', submissionId)
  form.append('context', JSON.stringify(context))
  form.append('files', new Blob([draft.detail], { type: 'text/plain' }), ATTACHMENT_NAME)

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
  try {
    const response = await fetch(FEEDBACK_URL, { method: 'POST', body: form, signal: controller.signal })
    let body: { error?: string; data?: { thread_key?: string } } | null = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`)
    }
    const threadKey = body?.data?.thread_key
    if (!threadKey) throw new Error(t('panel.feedback.noKey'))
    // 成功后清掉：同文案下次提交是新反馈，不能被平台当成重试返回旧线程。
    // 失败时保留，重试沿用同一个号；在途的重复点击此前已取到同一个号，不受影响。
    submissionIds.delete(draft.summary)
    // 平台已经收下反馈，浏览器禁用存储也不能把成功误报成发送失败。
    try { rememberFeedbackThread(threadKey, draft.summary) } catch { /* 编号仍由回执显示，可复制找回 */ }
    return { threadKey, submissionId }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(t('panel.feedback.timeout'))
    throw error
  } finally {
    window.clearTimeout(timer)
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
                <FeedbackButton threadKey={threadKey} onOpen={() => setOpen(false)} />
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
