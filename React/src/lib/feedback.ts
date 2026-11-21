// 插件反馈编号持久保存在本机，查看与续回复共用宿主反馈服务。
import { apiGet, apiPost } from './api.ts'

const STORAGE_KEY = 'dsh-mobile-plugin.feedback.threads'
export const FEEDBACK_CHANGED = 'dsh-mobile-plugin:feedback-changed'
export const FEEDBACK_OPEN = 'dsh-mobile-plugin:feedback-open'

type FeedbackAttachment = { id: number; file_name: string; url: string }
export type FeedbackMessage = {
  id: number
  author: 'user' | 'staff'
  content: string
  created_at: string
  attachments?: FeedbackAttachment[]
}
export type FeedbackThread = {
  thread_key: string
  status: string
  messages: FeedbackMessage[]
}
export type SavedFeedback = { key: string; title: string }

/** 只保存定位线程所需的编号和标题，不缓存对话正文。 */
export function savedFeedbackThreads(): SavedFeedback[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is SavedFeedback => !!row && typeof row.key === 'string' && !!row.key
      && typeof row.title === 'string')
  } catch {
    return []
  }
}

export function rememberFeedbackThread(key: string, title: string): void {
  if (!key.trim()) return
  const current = savedFeedbackThreads()
  const previous = current.find((row) => row.key === key)
  const row = { key, title: title.trim().split('\n')[0].slice(0, 120) || previous?.title || key }
  localStorage.setItem(STORAGE_KEY, JSON.stringify([row, ...current.filter((item) => item.key !== key)]))
  window.dispatchEvent(new Event(FEEDBACK_CHANGED))
}

export function openFeedbackThread(key = ''): void {
  window.dispatchEvent(new CustomEvent(FEEDBACK_OPEN, { detail: key }))
}

export function readFeedbackThread(key: string): Promise<FeedbackThread> {
  return apiGet<FeedbackThread>(`/api/relay/feedback?thread_key=${encodeURIComponent(key)}`)
}

export async function replyFeedbackThread(key: string, content: string): Promise<void> {
  await apiPost('/api/relay/feedback', { threadKey: key, content })
}
